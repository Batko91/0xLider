import { fetchWooProducts } from "@/shared/woocommerce";
import logger from "@/utiles/logger";
import fs from "fs/promises";
import path from "path";
import config from "../variables";
import { createClient } from "./OlxExport";

const SUGGESTIONS_FILE = "olx_category_suggestions.json";
/** Сколько названий товаров из каждой категории отправлять в подсказку OLX */
const SAMPLES_PER_CATEGORY = 3;

/**
 * Подбирает категории OLX для категорий WooCommerce: по названиям товаров
 * спрашивает /categories/suggestion и голосованием выбирает лучшую.
 * Результат — готовый olx.categoryMap и обязательные атрибуты каждой категории.
 */
export async function OlxCategorySuggestions(): Promise<void> {
  const client = createClient();
  const products = await fetchWooProducts(config.woocommerce);

  const byCategory = new Map<string, { name: string; titles: string[] }>();
  for (const product of products) {
    for (const category of product.categories) {
      const item = byCategory.get(category.slug) ?? {
        name: category.name,
        titles: [],
      };
      item.titles.push(product.name);
      byCategory.set(category.slug, item);
    }
  }

  const categoryMap: Record<string, number> = {};
  const details = [];
  for (const [slug, { name, titles }] of byCategory) {
    const votes = new Map<
      number,
      { id: number; name: string; path: string; votes: number }
    >();
    for (const title of titles.slice(0, SAMPLES_PER_CATEGORY)) {
      const suggestions = await client.suggestCategories(title.slice(0, 70));
      for (const s of suggestions.slice(0, 3)) {
        const item = votes.get(s.id) ?? {
          id: s.id,
          name: s.name,
          path: (s.path ?? []).map((p) => p.name).join(" / "),
          votes: 0,
        };
        item.votes++;
        votes.set(s.id, item);
      }
    }
    const ranked = [...votes.values()].sort((a, b) => b.votes - a.votes);
    const best = ranked[0];
    if (best) categoryMap[slug] = best.id;

    const required = best
      ? (await client.categoryAttributes(best.id))
          .filter((a) => a.validation.required)
          .map((a) => ({
            code: a.code,
            label: a.label,
            values: a.values?.map((v) => `${v.code}=${v.label}`),
          }))
      : [];

    details.push({
      wooCategory: name,
      slug,
      products: titles.length,
      suggestions: ranked,
      requiredAttributes: required,
    });
    logger.log(
      best ? "info" : "warning",
      `${name} (${slug}) → ${best ? `${best.id} ${best.path || best.name}` : "нет подсказки"}`
    );
  }

  const filePath = path.join(config.directory, SUGGESTIONS_FILE);
  await fs.mkdir(config.directory, { recursive: true });
  await fs.writeFile(
    filePath,
    JSON.stringify({ categoryMap, details }, null, 2),
    "utf-8"
  );
  logger.log(
    "success",
    `Сохранено в ${filePath} — проверьте и перенесите categoryMap в app/variables/index.ts`
  );
}

export async function OlxCategoryTree(parentId?: number): Promise<void> {
  const categories = await createClient().categories(parentId);
  console.table(
    categories.map((c) => ({
      id: c.id,
      name: c.name,
      parent: c.parent_id,
      leaf: c.is_leaf,
    }))
  );
}

export async function OlxCategoryAttributes(categoryId: number): Promise<void> {
  const attributes = await createClient().categoryAttributes(categoryId);
  for (const a of attributes) {
    const flags = [
      a.validation.required && "обязательный",
      a.validation.numeric && "число",
      a.validation.allow_multiple_values && "несколько значений",
    ]
      .filter(Boolean)
      .join(", ");
    console.log(
      `${a.code} — ${a.label}${a.unit ? ` (${a.unit})` : ""}${flags ? ` [${flags}]` : ""}`
    );
    if (a.values?.length) {
      console.log(
        `   ${a.values.map((v) => `${v.code}=${v.label}`).join(", ")}`
      );
    }
  }
}

export async function OlxCities(query?: string): Promise<void> {
  const client = createClient();
  const needle = query?.toLowerCase();
  const found = [];
  for (let offset = 0; ; offset += 1000) {
    const batch = await client.cities(offset, 1000);
    found.push(
      ...batch.filter((c) => !needle || c.name.toLowerCase().includes(needle))
    );
    if (batch.length < 1000) break;
  }
  console.table(
    found.map((c) => ({ id: c.id, name: c.name, region: c.region_id }))
  );
}

export async function OlxDistricts(cityId: number): Promise<void> {
  const districts = await createClient().cityDistricts(cityId);
  console.table(districts.map((d) => ({ id: d.id, name: d.name })));
}

export async function OlxCurrencies(): Promise<void> {
  console.table(await createClient().currencies());
}

export async function OlxMe(): Promise<void> {
  console.log(await createClient().me());
}
