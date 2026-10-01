import { OlxApiError, OlxClient } from "@/shared/olx/client";
import type {
  OlxAdvert,
  OlxAdvertPayload,
  OlxAttributeValue,
  OlxCategoryAttribute,
} from "@/shared/olx/types";
import { randomDelay } from "@/shared/randomDelay";
import { fetchWooProducts, type WooProduct } from "@/shared/woocommerce";
import logger from "@/utiles/logger";
import { createHash } from "crypto";
import fs from "fs/promises";
import path from "path";
import config from "../variables";

const TITLE_MAX = 70;
const DESCRIPTION_MIN = 80;
const DESCRIPTION_MAX = 9000;
/** Статусы OLX, из которых объявление возвращается командой activate */
const INACTIVE_STATUSES = new Set(["removed_by_user", "outdated"]);

export interface ExportStateEntry {
  advertId: number;
  /** Хеш последнего отправленного payload — по нему видно, что товар изменился */
  hash: string;
  status: "active" | "deactivated";
  url?: string;
  updatedAt: string;
}

/** id товара WooCommerce -> объявление OLX */
export type ExportState = Record<string, ExportStateEntry>;

type ReportAction =
  | "created"
  | "updated"
  | "activated"
  | "unchanged"
  | "deactivated"
  | "skipped"
  | "error"
  | "preview";

interface ReportEntry {
  productId: number;
  name: string;
  action: ReportAction;
  advertId?: number;
  olxStatus?: string;
  url?: string;
  message?: string;
}

export interface OlxExportOptions {
  /** Только собрать объявления в preview-файл, ничего не отправляя в OLX */
  dryRun?: boolean;
  /** Обработать не больше N товаров (для пробного запуска) */
  limit?: number;
  /** Обработать только эти товары WooCommerce */
  productIds?: number[];
}

class ProductSkip extends Error {}

const olx = config.olx;
const outputPath = (fileName: string) => path.join(config.directory, fileName);

// ---------- Текст ----------

const ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  laquo: "«",
  raquo: "»",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  times: "×",
  deg: "°",
};

export function htmlToText(html: string): string {
  return (
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<\/(p|div|li|h[1-6]|tr|ul|ol)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      // шорткоды конструкторов страниц: [vc_row], [et_pb_text ...]
      .replace(/\[\/?[a-z]+[_-][a-z0-9_-]*[^\]]*\]/g, "")
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
        String.fromCodePoint(parseInt(hex, 16))
      )
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
      .replace(
        /&([a-z]+);/gi,
        (match, name) => ENTITIES[name.toLowerCase()] ?? match
      )
      .replace(/[ \t ]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut)
    .replace(/[\s,.;:–—-]+$/, "")
    .trim();
}

function buildTitle(product: WooProduct): string {
  return truncate(htmlToText(product.name), TITLE_MAX);
}

function buildDescription(product: WooProduct): string {
  const body = htmlToText(product.description || product.short_description);
  const attributes = product.attributes
    .filter((a) => a.visible !== false && a.options.length)
    .map((a) => `${a.name}: ${a.options.join(", ")}`);

  const parts = [
    body || htmlToText(product.name),
    attributes.length ? attributes.join("\n") : "",
    product.sku ? `Артикул: ${product.sku}` : "",
    olx.descriptionFooter,
  ].filter(Boolean);

  const description = truncate(parts.join("\n\n"), DESCRIPTION_MAX);
  if (description.length < DESCRIPTION_MIN) {
    throw new ProductSkip(
      `описание короче ${DESCRIPTION_MIN} символов — дополните товар или olx.descriptionFooter`
    );
  }
  return description;
}

// ---------- Категории и атрибуты ----------

const suggestionCache = new Map<string, number | null>();
const attributesCache = new Map<number, OlxCategoryAttribute[]>();

async function resolveCategory(
  product: WooProduct,
  client: OlxClient | null
): Promise<number> {
  for (const category of product.categories) {
    const mapped = olx.categoryMap[category.slug];
    if (mapped) return mapped;
  }
  if (olx.defaultCategoryId) return olx.defaultCategoryId;

  if (olx.useCategorySuggestion && client) {
    const title = buildTitle(product);
    if (!suggestionCache.has(title)) {
      const [best] = await client.suggestCategories(title);
      suggestionCache.set(title, best?.id ?? null);
    }
    const suggested = suggestionCache.get(title);
    if (suggested) return suggested;
  }

  const slugs = product.categories.map((c) => c.slug).join(", ") || "—";
  throw new ProductSkip(
    `нет категории OLX для категорий [${slugs}] — добавьте их в olx.categoryMap (bun run olx categories)`
  );
}

async function getCategoryAttributes(
  categoryId: number,
  client: OlxClient | null
): Promise<OlxCategoryAttribute[] | null> {
  if (!client) return null;
  if (!attributesCache.has(categoryId)) {
    attributesCache.set(
      categoryId,
      await client.categoryAttributes(categoryId)
    );
  }
  return attributesCache.get(categoryId)!;
}

const normalize = (value: string) => value.trim().toLowerCase();

/** Ищет значение атрибута OLX среди атрибутов товара WooCommerce (по названию) */
function attributeFromProduct(
  product: WooProduct,
  attribute: OlxCategoryAttribute
): OlxAttributeValue | null {
  const names = [attribute.label, attribute.code]
    .filter(Boolean)
    .map(normalize);
  const source = product.attributes.find((a) =>
    names.includes(normalize(a.name))
  );
  if (!source?.options.length) return null;

  if (attribute.values?.length) {
    const codes = source.options
      .map(
        (option) =>
          attribute.values!.find(
            (v) =>
              normalize(v.label) === normalize(option) ||
              normalize(v.code) === normalize(option)
          )?.code
      )
      .filter((code): code is string => Boolean(code));
    if (!codes.length) return null;
    return attribute.validation.allow_multiple_values
      ? { code: attribute.code, values: codes }
      : { code: attribute.code, value: codes[0] };
  }

  const value = source.options[0];
  if (attribute.validation.numeric && Number.isNaN(Number(value))) return null;
  return { code: attribute.code, value };
}

async function buildAttributes(
  product: WooProduct,
  categoryId: number,
  client: OlxClient | null
): Promise<OlxAttributeValue[]> {
  const configured = new Map<string, OlxAttributeValue>();
  for (const attribute of [
    ...(olx.attributes["*"] ?? []),
    ...(olx.attributes[String(categoryId)] ?? []),
  ]) {
    configured.set(attribute.code, attribute);
  }

  const categoryAttributes = await getCategoryAttributes(categoryId, client);
  // Без доступа к API (dry-run без токена) отправляем атрибуты как есть
  if (!categoryAttributes) return [...configured.values()];

  const result: OlxAttributeValue[] = [];
  const missing: string[] = [];
  for (const attribute of categoryAttributes) {
    const value =
      configured.get(attribute.code) ??
      attributeFromProduct(product, attribute);
    if (value) {
      result.push(value);
    } else if (attribute.validation.required) {
      const options = attribute.values
        ?.slice(0, 10)
        .map((v) => `${v.code}=${v.label}`)
        .join(", ");
      missing.push(
        `${attribute.code} «${attribute.label}»${options ? ` [${options}]` : ""}`
      );
    }
  }
  if (missing.length) {
    throw new ProductSkip(
      `категория ${categoryId}: не заданы обязательные атрибуты ${missing.join("; ")} — добавьте их в olx.attributes["${categoryId}"]`
    );
  }
  return result;
}

// ---------- Объявление ----------

function isEligible(product: WooProduct): { ok: boolean; reason?: string } {
  if (product.status !== "publish")
    return { ok: false, reason: "не опубликован" };
  if (!(Number(product.price) > 0)) return { ok: false, reason: "нет цены" };
  if (
    product.stock_status === "outofstock" &&
    !config.woocommerce.includeOutOfStock
  ) {
    return { ok: false, reason: "нет в наличии" };
  }
  return { ok: true };
}

export async function buildAdvertPayload(
  product: WooProduct,
  client: OlxClient | null
): Promise<OlxAdvertPayload> {
  const categoryId = await resolveCategory(product, client);
  const images = product.images
    .map((image) => image.src)
    .filter(Boolean)
    .slice(0, olx.maxImages)
    .map((url) => ({ url }));

  return {
    title: buildTitle(product),
    description: buildDescription(product),
    category_id: categoryId,
    advertiser_type: olx.advertiserType,
    external_id: String(product.id),
    external_url: product.permalink,
    contact: {
      name: olx.contact.name,
      ...(olx.contact.phone ? { phone: olx.contact.phone } : {}),
    },
    location: {
      city_id: olx.location.cityId,
      ...(olx.location.districtId
        ? { district_id: olx.location.districtId }
        : {}),
    },
    images,
    price: {
      value: Number(product.price),
      currency: olx.currency,
      negotiable: olx.negotiable,
    },
    attributes: await buildAttributes(product, categoryId, client),
  };
}

const hashPayload = (payload: OlxAdvertPayload) =>
  createHash("sha1").update(JSON.stringify(payload)).digest("hex");

// ---------- Файлы ----------

async function readState(): Promise<ExportState> {
  try {
    return JSON.parse(
      await fs.readFile(outputPath(olx.stateFileName), "utf-8")
    ) as ExportState;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return {};
    throw new Error(`Не удалось прочитать ${olx.stateFileName}: ${error}`);
  }
}

async function writeJson(fileName: string, data: unknown): Promise<void> {
  await fs.mkdir(config.directory, { recursive: true });
  await fs.writeFile(
    outputPath(fileName),
    JSON.stringify(data, null, 2),
    "utf-8"
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof OlxApiError) return error.toString();
  return error instanceof Error ? error.message : String(error);
}

export function createClient(): OlxClient {
  return new OlxClient({
    baseUrl: olx.baseUrl,
    clientId: olx.clientId,
    clientSecret: olx.clientSecret,
    scope: olx.scope,
    tokenFile: outputPath(olx.tokenFileName),
  });
}

function validateConfig(): void {
  const problems: string[] = [];
  if (!olx.contact.name) problems.push("olx.contact.name (OLX_CONTACT_NAME)");
  if (!olx.location.cityId) problems.push("olx.location.cityId (OLX_CITY_ID)");
  if (problems.length) {
    throw new Error(`Не заполнены настройки: ${problems.join(", ")}`);
  }
}

// ---------- Синхронизация ----------

export async function OlxExport(options: OlxExportOptions = {}): Promise<void> {
  const { dryRun = false } = options;
  logger.log(
    "info",
    `Выгрузка товаров WooCommerce -> OLX${dryRun ? " (dry-run)" : ""}`
  );
  validateConfig();

  let client: OlxClient | null = null;
  if (dryRun) {
    // В dry-run API нужен только для чтения категорий и атрибутов
    try {
      client = createClient();
      await client.me();
    } catch (error) {
      logger.log(
        "warning",
        `OLX API недоступен (${errorMessage(error)}): категории берутся только из olx.categoryMap, атрибуты не проверяются`
      );
      client = null;
    }
  } else {
    client = createClient();
    const me = await client.me();
    logger.log("success", `Авторизован в OLX: ${me.email ?? me.name ?? me.id}`);
  }

  let products = await fetchWooProducts(config.woocommerce);
  if (options.productIds?.length) {
    const ids = new Set(options.productIds);
    products = products.filter((p) => ids.has(p.id));
  }
  if (options.limit) products = products.slice(0, options.limit);
  logger.log("info", `Товаров к обработке: ${products.length}`);

  const state = await readState();
  const report: ReportEntry[] = [];
  const preview: { productId: number; payload: OlxAdvertPayload }[] = [];
  const seen = new Set<string>();

  const deactivate = async (key: string, entry: ExportStateEntry) => {
    await client!.deactivateAdvert(entry.advertId);
    state[key] = {
      ...entry,
      status: "deactivated",
      updatedAt: new Date().toISOString(),
    };
    await writeJson(olx.stateFileName, state);
    await randomDelay(olx.requestDelay.min, olx.requestDelay.max);
  };

  for (const [index, product] of products.entries()) {
    const key = String(product.id);
    const entry = state[key];
    seen.add(key);
    const base = { productId: product.id, name: product.name };
    logger.log(
      "info",
      `[${index + 1}/${products.length}] ${product.name} (#${product.id})`
    );

    try {
      const eligibility = isEligible(product);
      if (!eligibility.ok) {
        if (!dryRun && entry?.status === "active" && olx.deactivateMissing) {
          await deactivate(key, entry);
          report.push({
            ...base,
            action: "deactivated",
            advertId: entry.advertId,
            message: eligibility.reason,
          });
        } else {
          report.push({
            ...base,
            action: "skipped",
            message: eligibility.reason,
          });
        }
        continue;
      }

      const payload = await buildAdvertPayload(product, client);
      const hash = hashPayload(payload);

      if (dryRun) {
        preview.push({ productId: product.id, payload });
        report.push({ ...base, action: "preview", advertId: entry?.advertId });
        continue;
      }

      let current: ExportStateEntry | undefined = entry;
      if (!current) {
        // Объявление могло быть создано раньше, а файл состояния — потеряться
        const existing = await client!.findAdvertByExternalId(key);
        if (existing) {
          current = {
            advertId: existing.id,
            hash: "",
            status: INACTIVE_STATUSES.has(existing.status)
              ? "deactivated"
              : "active",
            url: existing.url,
            updatedAt: new Date().toISOString(),
          };
          logger.log(
            "info",
            `Найдено существующее объявление OLX #${existing.id}`
          );
        }
      }

      let advert: OlxAdvert | null = null;
      let action: ReportAction;
      if (!current) {
        advert = await client!.createAdvert(payload);
        action = "created";
      } else if (current.hash !== hash) {
        try {
          advert = await client!.updateAdvert(current.advertId, payload);
          action = "updated";
        } catch (error) {
          if (!(error instanceof OlxApiError && error.status === 404))
            throw error;
          // Объявление удалили на OLX вручную — публикуем заново
          logger.log(
            "warning",
            `Объявление #${current.advertId} не найдено на OLX, создаём заново`
          );
          advert = await client!.createAdvert(payload);
          action = "created";
          current = undefined;
        }
      } else {
        action = "unchanged";
      }

      const advertId = advert?.id ?? current!.advertId;
      let message: string | undefined;
      if (current?.status === "deactivated") {
        await client!.activateAdvert(advertId);
        message = action === "updated" ? "обновлено и активировано" : undefined;
        action = "activated";
      }

      state[key] = {
        advertId,
        hash,
        status: "active",
        url: advert?.url ?? current?.url,
        updatedAt: new Date().toISOString(),
      };
      await writeJson(olx.stateFileName, state);
      report.push({
        ...base,
        action,
        advertId,
        olxStatus: advert?.status,
        url: state[key].url,
        message,
      });
      logger.log(
        "success",
        `${action}: объявление #${advertId}${advert?.status ? ` (${advert.status})` : ""}`
      );

      if (action !== "unchanged") {
        await randomDelay(olx.requestDelay.min, olx.requestDelay.max);
      }
    } catch (error) {
      const message = errorMessage(error);
      const action = error instanceof ProductSkip ? "skipped" : "error";
      logger.log(
        action === "error" ? "error" : "warning",
        `${product.name}: ${message}`
      );
      report.push({ ...base, action, advertId: entry?.advertId, message });
    }
  }

  // Товары, которые исчезли из магазина (удалены или сняты с публикации).
  // Пустой ответ магазина скорее сбой, чем удаление всех товаров — тогда ничего не снимаем
  if (!dryRun && olx.deactivateMissing && products.length === 0) {
    logger.log(
      "warning",
      "WooCommerce не вернул ни одного товара — объявления не снимаются"
    );
  } else if (
    !dryRun &&
    olx.deactivateMissing &&
    !options.productIds?.length &&
    !options.limit
  ) {
    for (const [key, entry] of Object.entries(state)) {
      if (seen.has(key) || entry.status !== "active") continue;
      const base = { productId: Number(key), name: "(нет в магазине)" };
      try {
        await deactivate(key, entry);
        report.push({
          ...base,
          action: "deactivated",
          advertId: entry.advertId,
        });
        logger.log(
          "info",
          `Снято с публикации объявление #${entry.advertId} (товар #${key} удалён)`
        );
      } catch (error) {
        report.push({
          ...base,
          action: "error",
          advertId: entry.advertId,
          message: errorMessage(error),
        });
      }
    }
  }

  await writeJson(olx.reportFileName, {
    finishedAt: new Date().toISOString(),
    dryRun,
    items: report,
  });
  if (dryRun) await writeJson(olx.previewFileName, preview);

  const summary = report.reduce<Record<string, number>>((acc, item) => {
    acc[item.action] = (acc[item.action] ?? 0) + 1;
    return acc;
  }, {});
  logger.log("success", `Готово: ${JSON.stringify(summary)}`);
  logger.log("info", `Отчёт: ${outputPath(olx.reportFileName)}`);
  if (dryRun)
    logger.log("info", `Объявления: ${outputPath(olx.previewFileName)}`);
}
