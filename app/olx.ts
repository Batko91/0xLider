import { OlxAuth } from "./chunks/OlxAuth";
import {
  OlxCategoryAttributes,
  OlxCategorySuggestions,
  OlxCategoryTree,
  OlxCities,
  OlxCurrencies,
  OlxDistricts,
  OlxMe,
} from "./chunks/OlxDictionaries";
import { OlxExport } from "./chunks/OlxExport";
import logger from "./utiles/logger";

const HELP = `
Выгрузка товаров WooCommerce на OLX (Partner API v2)

  bun run olx auth [--code КОД]       авторизация аккаунта OLX (токен -> output/)
  bun run olx export [--dry-run] [--limit N] [--product ID,ID]
                                      создать/обновить/снять объявления
  bun run olx categories              подобрать категории OLX для категорий магазина
  bun run olx categories --tree [ID]  дерево категорий OLX
  bun run olx attributes ID           атрибуты категории OLX
  bun run olx cities [название]       города OLX (id для OLX_CITY_ID)
  bun run olx districts ID_ГОРОДА     районы города
  bun run olx currencies              валюты OLX
  bun run olx me                      текущий аккаунт OLX
`;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function requireNumber(value: string | undefined, what: string): number {
  const number = Number(value);
  if (!value || !Number.isInteger(number)) throw new Error(`Укажите ${what}`);
  return number;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "auth":
      return OlxAuth(option(args, "--code"));
    case "export":
      return OlxExport({
        dryRun: args.includes("--dry-run"),
        limit: option(args, "--limit")
          ? requireNumber(option(args, "--limit"), "число после --limit")
          : undefined,
        productIds: option(args, "--product")
          ?.split(",")
          .map(Number)
          .filter(Boolean),
      });
    case "categories":
      return args.includes("--tree")
        ? OlxCategoryTree(
            option(args, "--tree") ? Number(option(args, "--tree")) : undefined
          )
        : OlxCategorySuggestions();
    case "attributes":
      return OlxCategoryAttributes(requireNumber(args[0], "id категории OLX"));
    case "cities":
      return OlxCities(args.join(" ") || undefined);
    case "districts":
      return OlxDistricts(requireNumber(args[0], "id города OLX"));
    case "currencies":
      return OlxCurrencies();
    case "me":
      return OlxMe();
    default:
      console.log(HELP);
  }
}

main().catch((error) => {
  logger.log("error", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
