# Выгрузка товаров WooCommerce на OLX

`bun run olx export` берёт опубликованные товары магазина через WooCommerce REST API и публикует их объявлениями на OLX через Partner API v2:

- новый товар → создаётся объявление;
- изменились название, описание, цена, фото или категория → объявление обновляется;
- товар закончился, у него пропала цена или его удалили из магазина → объявление снимается с публикации;
- товар снова в продаже → объявление активируется.

Связь «товар ↔ объявление» хранится в `output/olx_export_state.json`. Если этот файл потеряется, объявления найдутся по `external_id` (id товара WooCommerce), и дублей не будет.

## Настройка

1. **Ключи.** Скопируйте `.env.example` в `.env` и заполните:
   - `OLX_CLIENT_ID`, `OLX_CLIENT_SECRET` — ключи приложения OLX Partner API. В настройках приложения OLX укажите redirect URI `http://localhost:3000/olx/callback` (или задайте свой в `OLX_REDIRECT_URI`);
   - `WC_URL`, `WC_CONSUMER_KEY`, `WC_CONSUMER_SECRET` — ключи WooCommerce (WooCommerce → Настройки → Дополнительно → REST API, права «Чтение»);
   - `OLX_CONTACT_NAME`, `OLX_CONTACT_PHONE` — контакт в объявлениях.
2. **Авторизация OLX.** Выполните `bun run olx auth`, откройте ссылку и разрешите доступ. Токен сохранится в `output/olx_token.json` и дальше будет обновляться сам. Если redirect URI ведёт не на этот компьютер, скопируйте `code` из адресной строки и выполните `bun run olx auth --code <код>`.
3. **Город.** `bun run olx cities Ташкент` → id в `OLX_CITY_ID`. Район, если нужен: `bun run olx districts <id города>` → `OLX_DISTRICT_ID`.
4. **Категории.** `bun run olx categories` подбирает категорию OLX для каждой категории магазина и пишет результат в `output/olx_category_suggestions.json`. Проверьте его и перенесите `categoryMap` в `olx.categoryMap` в `app/variables/index.ts`. Для товаров вне `categoryMap` категория подбирается по названию, если включено `useCategorySuggestion`.
5. **Атрибуты.** В том же файле для каждой категории перечислены обязательные атрибуты с допустимыми значениями (полный список: `bun run olx attributes <id>`). Значения по умолчанию задаются в `olx.attributes`:
   ```ts
   attributes: {
     "*": [{ code: "state", value: "new" }], // для всех категорий
     "1234": [{ code: "brand", value: "schneider" }],
   },
   ```
   Атрибут OLX, которого нет в конфиге, заполняется из атрибута товара WooCommerce с тем же названием, например «Бренд». Атрибуты, которых нет в категории OLX, не отправляются.
6. **Проверка.** `bun run olx:preview` ничего не публикует, а только сохраняет готовые объявления в `output/olx_export_preview.json` и отчёт в `output/olx_export_report.json`. Пробную выгрузку можно ограничить: `bun run olx export --limit 3` или `--product 11,12`.
7. **Выгрузка.** `bun run olx:export`. Для регулярной синхронизации добавьте запуск в cron или в Планировщик заданий, например каждые 6 часов: `0 */6 * * * cd /path/to/0xLider && bun run olx:export`.

## Как товар превращается в объявление

| OLX               | WooCommerce / настройки                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| title             | название, обрезается до 70 символов                                                                 |
| description       | описание (HTML → текст), видимые атрибуты, артикул, `olx.descriptionFooter`; от 80 до 9000 символов |
| price             | `price` (с учётом скидки), валюта `olx.currency`: `UZS` или `UYE`                                   |
| images            | ссылки на фото товара, не больше `olx.maxImages`                                                    |
| category_id       | `olx.categoryMap` → `olx.defaultCategoryId` → подсказка OLX по названию                             |
| attributes        | `olx.attributes` + атрибуты товара                                                                  |
| contact, location | `OLX_CONTACT_*`, `OLX_CITY_ID`, `OLX_DISTRICT_ID`                                                   |
| external_id/url   | id и ссылка товара                                                                                  |

## Отчёт

В `output/olx_export_report.json` у каждого товара есть поле `action`:

- `created`, `updated`, `activated`, `deactivated`, `unchanged` — что произошло с объявлением;
- `skipped` — товар не выгружается, причина в `message`: нет цены, нет в наличии, короткое описание, не настроена категория или обязательный атрибут;
- `error` — OLX отклонил объявление, в `message` текст ошибки и поля, не прошедшие проверку.

## Ограничения

- Фото OLX скачивает сам по ссылкам, поэтому они должны быть доступны из интернета.
- Сверх бесплатного лимита категории OLX может поставить объявлению статус `limited` (нужен платный пакет). Статус виден в отчёте в поле `olxStatus`.
- Объявление, которое удалили на OLX вручную, создаётся заново при следующем изменении товара.
