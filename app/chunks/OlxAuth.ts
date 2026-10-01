import logger from "@/utiles/logger";
import { randomBytes } from "crypto";
import config from "../variables";
import { createClient } from "./OlxExport";

const AUTH_TIMEOUT_MS = 10 * 60 * 1000;

function redirectUri(): string {
  return (
    process.env.OLX_REDIRECT_URI ||
    `http://${config.server.host}:${config.server.port}${config.olx.redirectPath}`
  );
}

/**
 * Авторизация пользователя OLX (OAuth authorization_code).
 * Без кода — поднимает локальный сервер на config.server и ждёт редиректа от OLX.
 * С кодом (--code) — сразу обменивает его на токен; удобно, если redirect_uri
 * приложения указывает не на этот компьютер и код копируется из адресной строки.
 */
export async function OlxAuth(code?: string): Promise<void> {
  const client = createClient();
  const redirect = redirectUri();

  if (code) {
    await client.exchangeCode(code, redirect);
    logger.log("success", "Токен OLX получен и сохранён");
    return;
  }

  const state = randomBytes(16).toString("hex");
  const callbackPath = new URL(redirect).pathname;

  const received = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Не дождались авторизации за 10 минут")),
      AUTH_TIMEOUT_MS
    );

    const server = Bun.serve({
      hostname: config.server.host,
      port: config.server.port,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname !== callbackPath) {
          return new Response("Not found", { status: 404 });
        }
        const error = url.searchParams.get("error");
        const authCode = url.searchParams.get("code");
        const done = (message: string) =>
          new Response(`<meta charset="utf-8"><h3>${message}</h3>`, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });

        if (error) {
          reject(new Error(`OLX вернул ошибку: ${error}`));
        } else if (url.searchParams.get("state") !== state) {
          return done("Неверный state — запустите авторизацию заново.");
        } else if (authCode) {
          resolve(authCode);
        } else {
          return done("В ответе OLX нет кода авторизации.");
        }
        clearTimeout(timer);
        setTimeout(() => server.stop(), 500);
        return done(
          error
            ? "Авторизация отклонена. Окно можно закрыть."
            : "Готово, токен получен. Окно можно закрыть."
        );
      },
    });
  });

  logger.log(
    "info",
    `Redirect URI (должен совпадать с настройками приложения OLX): ${redirect}`
  );
  logger.log("info", "Откройте ссылку в браузере и разрешите доступ:");
  console.log(`\n${client.authorizeUrl(redirect, state)}\n`);

  const authCode = await received;
  await client.exchangeCode(authCode, redirect);
  const me = await client.me();
  logger.log(
    "success",
    `Токен OLX сохранён. Аккаунт: ${me.email ?? me.name ?? me.id}`
  );
}
