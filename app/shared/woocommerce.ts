import type { WooCommerceConfig } from "@/variables/variables";
import logger from "@/utiles/logger";

/** Поля товара WooCommerce REST API v3, которые нужны для выгрузки */
export interface WooProduct {
  id: number;
  name: string;
  slug: string;
  permalink: string;
  type: string;
  status: string;
  sku: string;
  price: string;
  regular_price: string;
  sale_price: string;
  description: string;
  short_description: string;
  stock_status: "instock" | "outofstock" | "onbackorder";
  categories: { id: number; name: string; slug: string }[];
  images: { id: number; src: string; alt?: string }[];
  attributes: {
    id: number;
    name: string;
    visible?: boolean;
    options: string[];
  }[];
  date_modified_gmt?: string;
}

/**
 * Загружает все опубликованные товары магазина постранично
 * (GET /wp-json/wc/v3/products, авторизация по ключам REST API WooCommerce).
 */
export async function fetchWooProducts(
  options: WooCommerceConfig
): Promise<WooProduct[]> {
  if (!options.url || !options.consumerKey || !options.consumerSecret) {
    throw new Error(
      "Не заданы WC_URL / WC_CONSUMER_KEY / WC_CONSUMER_SECRET (см. .env.example)"
    );
  }

  const baseUrl = options.url.replace(/\/+$/, "");
  const auth = Buffer.from(
    `${options.consumerKey}:${options.consumerSecret}`
  ).toString("base64");
  const products: WooProduct[] = [];
  // Часть хостингов вырезает заголовок Authorization — тогда WooCommerce
  // принимает ключи в параметрах запроса (только по HTTPS)
  let useQueryAuth = false;

  for (let page = 1; ; page++) {
    const url = new URL(`${baseUrl}/wp-json/wc/v3/products`);
    url.searchParams.set("status", "publish");
    url.searchParams.set("per_page", String(options.perPage));
    url.searchParams.set("page", String(page));
    if (useQueryAuth) {
      url.searchParams.set("consumer_key", options.consumerKey);
      url.searchParams.set("consumer_secret", options.consumerSecret);
    }

    const response = await fetch(url, {
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
    });
    if (response.status === 401 && !useQueryAuth) {
      logger.log(
        "warning",
        "WooCommerce: 401, пробуем ключи в параметрах запроса"
      );
      useQueryAuth = true;
      page--;
      continue;
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `WooCommerce ответил ${response.status} на ${url.pathname}: ${text.slice(0, 300)}`
      );
    }

    const batch = (await response.json()) as WooProduct[];
    products.push(...batch);

    const totalPages = Number(response.headers.get("X-WP-TotalPages")) || 1;
    logger.log(
      "info",
      `WooCommerce: страница ${page}/${totalPages}, товаров: ${products.length}`
    );
    if (page >= totalPages || batch.length === 0) break;
  }

  return products;
}
