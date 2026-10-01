type BrowserArgs = `--${string}`;

interface OlxAttributeConfig {
  code: string;
  value?: string;
  values?: string[];
}

interface OlxConfig {
  /** Хост OLX, например https://www.olx.uz */
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  /** Путь колбэка OAuth на локальном сервере (config.server) */
  redirectPath: string;
  tokenFileName: string;
  stateFileName: string;
  reportFileName: string;
  previewFileName: string;
  advertiserType: "private" | "business";
  /** Код валюты OLX: UZS или UYE (у.е.) — список: bun run olx currencies */
  currency: string;
  negotiable: boolean;
  contact: {
    name: string;
    phone?: string;
  };
  location: {
    cityId: number;
    districtId?: number;
  };
  maxImages: number;
  /** Добавляется в конец описания каждого объявления */
  descriptionFooter: string;
  /** slug категории WooCommerce -> id категории OLX */
  categoryMap: Record<string, number>;
  /** Категория OLX, если ни одна категория товара не найдена в categoryMap */
  defaultCategoryId: number | null;
  /** Подбирать категорию OLX по названию товара, если её нет в categoryMap */
  useCategorySuggestion: boolean;
  /** id категории OLX -> атрибуты по умолчанию ("*" — для всех категорий) */
  attributes: Record<string, OlxAttributeConfig[]>;
  /** Снимать с публикации объявления товаров, которые пропали из магазина */
  deactivateMissing: boolean;
  requestDelay: {
    min: number;
    max: number;
  };
}

interface WooCommerceConfig {
  /** Адрес сайта, например https://shop.uz */
  url: string;
  consumerKey: string;
  consumerSecret: string;
  perPage: number;
  /** Выгружать товары, которых нет в наличии */
  includeOutOfStock: boolean;
}

interface Variables<T> {
  url: T;
  ResultFileName: string;
  directory: string;
  browser?: {
    headless: boolean;
  };
  server: {
    host: string;
    port: number;
  };
  olx: OlxConfig;
  woocommerce: WooCommerceConfig;
  chunks: {
    ai: {
      timeout: number;
      maxAttempts: number;
      maxTokens: number;
      temperature: number;
      topP: number;
      frequencyPenalty: number;
      presencePenalty: number;
      leakedFileName: string;
      processedFileName: string;
      debugFileName: string;
    };
    filter: {
      keywords: ReadonlySet<string>[];
      outputFile: string;
    };
  };
}

class Config<T> implements Variables<T> {
  private static defaultConfig: Variables<string> = {
    url: "https://www.olx.uz/nedvizhimost/kvartiry/tashkent/?currency=UYE",
    ResultFileName: "result.json",
    directory: "./output",
    browser: {
      headless: true,
    },
    server: {
      host: "localhost",
      port: 3000,
    },
    olx: {
      baseUrl: "https://www.olx.uz",
      clientId: "",
      clientSecret: "",
      scope: "v2 read write",
      redirectPath: "/olx/callback",
      tokenFileName: "olx_token.json",
      stateFileName: "olx_export_state.json",
      reportFileName: "olx_export_report.json",
      previewFileName: "olx_export_preview.json",
      advertiserType: "business",
      currency: "UZS",
      negotiable: false,
      contact: {
        name: "",
      },
      location: {
        cityId: 0,
      },
      maxImages: 8,
      descriptionFooter: "",
      categoryMap: {},
      defaultCategoryId: null,
      useCategorySuggestion: false,
      attributes: {},
      deactivateMissing: true,
      requestDelay: {
        min: 500,
        max: 1500,
      },
    },
    woocommerce: {
      url: "",
      consumerKey: "",
      consumerSecret: "",
      perPage: 100,
      includeOutOfStock: false,
    },
    chunks: {
      ai: {
        timeout: 5000,
        maxAttempts: 3,
        maxTokens: 1000,
        temperature: 0.7,
        topP: 1,
        frequencyPenalty: 0,
        presencePenalty: 0,
        leakedFileName: "processed_data_leaked.json",
        processedFileName: "processed_data.json",
        debugFileName: "debug_processed_data.json",
      },
      filter: {
        keywords: [new Set(["default"])],
        outputFile: "filtered.json",
      },
    },
  };

  private config: Variables<T>;

  constructor(config: Partial<Variables<T>> = {} as Variables<T>) {
    this.config = {
      ...Config.defaultConfig,
      ...config,
      browser: { ...Config.defaultConfig.browser, ...config.browser }, // Гарантируем, что browser не undefined
    } as Variables<T>;
  }

  get url(): T {
    return this.config.url;
  }

  get ResultFileName(): string {
    return this.config.ResultFileName;
  }

  get directory(): string {
    return this.config.directory;
  }

  get server(): { host: string; port: number } {
    return this.config.server;
  }

  get olx(): OlxConfig {
    return this.config.olx;
  }

  get woocommerce(): WooCommerceConfig {
    return this.config.woocommerce;
  }

  get chunks(): Variables<T>["chunks"] {
    return this.config.chunks;
  }

  // Методы для работы с конфигурацией как с объектом
  toJSON(): Variables<T> {
    return { ...this.config };
  }

  static fromJSON<T>(json: Partial<Variables<T>>): Config<T> {
    return new Config<T>(json);
  }

  // Метод для обновления конфигурации
  updateConfig(newConfig: Partial<Variables<T>>): void {
    this.config = { ...this.config, ...newConfig };
  }

  // Метод для получения текущей конфигурации
  getConfig(): Variables<T> {
    return { ...this.config };
  }

  get browser(): Variables<T>["browser"] {
    return this.config.browser;
  }
}

// Создаем дефолтный экземпляр конфигурации
const defaultConfig = new Config();
export default defaultConfig;

export { Config, defaultConfig };
export type {
  BrowserArgs,
  OlxAttributeConfig,
  OlxConfig,
  Variables,
  WooCommerceConfig,
};
