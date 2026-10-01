import { delay } from "@/shared/randomDelay";
import logger from "@/utiles/logger";
import fs from "fs/promises";
import path from "path";
import type {
  OlxAdvert,
  OlxAdvertPayload,
  OlxCategory,
  OlxCategoryAttribute,
  OlxCategorySuggestion,
  OlxCity,
  OlxCurrency,
  OlxDistrict,
  OlxToken,
  OlxValidationError,
} from "./types";

const API_VERSION = "2.0";
const MAX_RETRIES = 3;
/** Обновляем токен заранее, за 5 минут до истечения */
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export interface OlxClientOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  /** Полный путь к файлу, где хранится токен пользователя */
  tokenFile: string;
}

type Query = Record<string, string | number | undefined>;

export class OlxApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly validation: OlxValidationError[] = []
  ) {
    super(message);
    this.name = "OlxApiError";
  }

  /** Текст ошибки вместе с ошибками валидации полей */
  toString(): string {
    const fields = this.validation
      .map((v) => [v.field, v.title, v.detail].filter(Boolean).join(": "))
      .filter(Boolean);
    return fields.length
      ? `${this.status} ${this.message} (${fields.join("; ")})`
      : `${this.status} ${this.message}`;
  }
}

export class OlxClient {
  private token: OlxToken | null = null;

  constructor(private readonly options: OlxClientOptions) {
    if (!options.clientId || !options.clientSecret) {
      throw new Error(
        "Не заданы OLX_CLIENT_ID / OLX_CLIENT_SECRET (см. .env.example)"
      );
    }
  }

  // ---------- OAuth ----------

  authorizeUrl(redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: this.options.clientId,
      response_type: "code",
      state,
      scope: this.options.scope,
      redirect_uri: redirectUri,
    });
    return `${this.options.baseUrl}/oauth/authorize/?${params}`;
  }

  /** Обмен кода авторизации на токен пользователя; токен сохраняется в файл */
  async exchangeCode(code: string, redirectUri: string): Promise<OlxToken> {
    return this.requestToken({
      grant_type: "authorization_code",
      code,
      scope: this.options.scope,
      redirect_uri: redirectUri,
    });
  }

  private async refreshToken(): Promise<OlxToken> {
    const refreshToken = this.token?.refresh_token;
    if (!refreshToken) {
      throw new Error(
        "Нет refresh_token. Авторизуйтесь заново: bun run olx auth"
      );
    }
    logger.log("info", "Обновление токена OLX");
    try {
      return await this.requestToken({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });
    } catch (error) {
      throw new Error(
        `Не удалось обновить токен OLX (${error}). Авторизуйтесь заново: bun run olx auth`
      );
    }
  }

  private async requestToken(
    params: Record<string, string>
  ): Promise<OlxToken> {
    const response = await fetch(
      `${this.options.baseUrl}/api/open/oauth/token`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
          ...params,
        }),
      }
    );
    const body = await readJson(response);
    if (!response.ok || !body?.access_token) {
      throw parseError(response.status, body);
    }
    const token: OlxToken = {
      ...body,
      // при обновлении OLX может не вернуть новый refresh_token
      refresh_token: body.refresh_token ?? this.token?.refresh_token,
      obtained_at: new Date().toISOString(),
    };
    await this.saveToken(token);
    return token;
  }

  private async loadToken(): Promise<OlxToken> {
    if (this.token) return this.token;
    try {
      const content = await fs.readFile(this.options.tokenFile, "utf-8");
      this.token = JSON.parse(content) as OlxToken;
      return this.token;
    } catch {
      throw new Error(
        `Токен OLX не найден (${this.options.tokenFile}). Сначала выполните: bun run olx auth`
      );
    }
  }

  private async saveToken(token: OlxToken): Promise<void> {
    this.token = token;
    await fs.mkdir(path.dirname(this.options.tokenFile), { recursive: true });
    await fs.writeFile(
      this.options.tokenFile,
      JSON.stringify(token, null, 2),
      "utf-8"
    );
  }

  private async getAccessToken(): Promise<string> {
    const token = await this.loadToken();
    const expiresAt =
      new Date(token.obtained_at).getTime() + token.expires_in * 1000;
    if (Date.now() > expiresAt - TOKEN_EXPIRY_MARGIN_MS) {
      return (await this.refreshToken()).access_token;
    }
    return token.access_token;
  }

  // ---------- HTTP ----------

  async request<T>(
    method: string,
    endpoint: string,
    options: { query?: Query; body?: unknown } = {}
  ): Promise<T> {
    const url = new URL(`${this.options.baseUrl}/api/partner${endpoint}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const accessToken = await this.getAccessToken();
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Version: API_VERSION,
            Authorization: `Bearer ${accessToken}`,
          },
          body:
            options.body === undefined
              ? undefined
              : JSON.stringify(options.body),
        });
      } catch (error) {
        if (attempt >= MAX_RETRIES) throw error;
        logger.log("warning", `Сетевая ошибка OLX (${error}), повтор...`);
        await delay(2000 * 2 ** attempt);
        continue;
      }

      if (response.status === 401 && !refreshed) {
        refreshed = true;
        await this.refreshToken();
        continue;
      }

      if (
        (response.status === 429 || response.status >= 500) &&
        attempt < MAX_RETRIES
      ) {
        const retryAfter = Number(response.headers.get("Retry-After"));
        const wait = retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt;
        logger.log(
          "warning",
          `OLX ответил ${response.status} на ${method} ${endpoint}, повтор через ${wait} мс`
        );
        await delay(wait);
        continue;
      }

      const body = await readJson(response);
      if (!response.ok) throw parseError(response.status, body);
      return body as T;
    }
  }

  // ---------- Справочники ----------

  async me(): Promise<Record<string, unknown>> {
    return (
      await this.request<{ data: Record<string, unknown> }>("GET", "/users/me")
    ).data;
  }

  async currencies(): Promise<OlxCurrency[]> {
    return (await this.request<{ data: OlxCurrency[] }>("GET", "/currencies"))
      .data;
  }

  async categories(parentId?: number): Promise<OlxCategory[]> {
    return (
      await this.request<{ data: OlxCategory[] }>("GET", "/categories", {
        query: { parent_id: parentId },
      })
    ).data;
  }

  async categoryAttributes(
    categoryId: number
  ): Promise<OlxCategoryAttribute[]> {
    return (
      await this.request<{ data: OlxCategoryAttribute[] }>(
        "GET",
        `/categories/${categoryId}/attributes`
      )
    ).data;
  }

  async suggestCategories(title: string): Promise<OlxCategorySuggestion[]> {
    return (
      await this.request<{ data: OlxCategorySuggestion[] }>(
        "GET",
        "/categories/suggestion",
        { query: { q: title } }
      )
    ).data;
  }

  async cities(offset = 0, limit = 1000): Promise<OlxCity[]> {
    return (
      await this.request<{ data: OlxCity[] }>("GET", "/cities", {
        query: { offset, limit },
      })
    ).data;
  }

  async cityDistricts(cityId: number): Promise<OlxDistrict[]> {
    return (
      await this.request<{ data: OlxDistrict[] }>(
        "GET",
        `/cities/${cityId}/districts`
      )
    ).data;
  }

  // ---------- Объявления ----------

  async findAdvertByExternalId(externalId: string): Promise<OlxAdvert | null> {
    const { data } = await this.request<{ data: OlxAdvert[] }>(
      "GET",
      "/adverts",
      { query: { external_id: externalId, limit: 1 } }
    );
    return data[0] ?? null;
  }

  async createAdvert(payload: OlxAdvertPayload): Promise<OlxAdvert> {
    return (
      await this.request<{ data: OlxAdvert }>("POST", "/adverts", {
        body: payload,
      })
    ).data;
  }

  async updateAdvert(
    id: number,
    payload: OlxAdvertPayload
  ): Promise<OlxAdvert> {
    return (
      await this.request<{ data: OlxAdvert }>("PUT", `/adverts/${id}`, {
        body: payload,
      })
    ).data;
  }

  async activateAdvert(id: number): Promise<void> {
    await this.request("POST", `/adverts/${id}/commands`, {
      body: { command: "activate" },
    });
  }

  async deactivateAdvert(id: number, isSuccess = false): Promise<void> {
    await this.request("POST", `/adverts/${id}/commands`, {
      body: { command: "deactivate", is_success: isSuccess },
    });
  }
}

async function readJson(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/**
 * Ошибки OLX приходят в двух форматах:
 * API — { error: { title, detail, validation: [...] } },
 * OAuth — { error: "invalid_grant", error_description: "..." }
 */
function parseError(status: number, body: any): OlxApiError {
  const error = body?.error;
  if (error && typeof error === "object") {
    return new OlxApiError(
      status,
      error.detail || error.title || error.message || "Ошибка OLX API",
      Array.isArray(error.validation) ? error.validation : []
    );
  }
  return new OlxApiError(
    status,
    body?.error_description ||
      body?.error_human_title ||
      (typeof error === "string" ? error : "") ||
      body?.raw?.slice(0, 300) ||
      "Ошибка OLX API"
  );
}
