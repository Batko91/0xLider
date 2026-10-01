/**
 * Типы OLX Partner API v2 (https://developer.olx.ua/api/doc — одинаков для всех стран OLX).
 */

export type OlxAdvertiserType = "private" | "business";

export interface OlxAttributeValue {
  code: string;
  value?: string;
  values?: string[];
}

export interface OlxAdvertPayload {
  title: string;
  description: string;
  category_id: number;
  advertiser_type: OlxAdvertiserType;
  external_id?: string;
  external_url?: string;
  contact: {
    name: string;
    phone?: string;
  };
  location: {
    city_id: number;
    district_id?: number;
    latitude?: number;
    longitude?: number;
  };
  images: { url: string }[];
  price?: {
    value: number;
    currency: string;
    negotiable?: boolean;
    trade?: boolean;
    budget?: boolean;
  };
  attributes?: OlxAttributeValue[];
  courier?: boolean;
}

export interface OlxAdvert extends OlxAdvertPayload {
  id: number;
  status: string;
  url?: string;
  created_at?: string;
  activated_at?: string;
  valid_to?: string;
}

export interface OlxCategory {
  id: number;
  name: string;
  parent_id: number;
  photos_limit?: number;
  is_leaf?: boolean;
}

export interface OlxCategorySuggestion {
  id: number;
  name: string;
  path?: { id: number; name: string }[];
}

export interface OlxCategoryAttribute {
  code: string;
  label: string;
  unit?: string | null;
  validation: {
    type: string;
    required: boolean;
    numeric?: boolean;
    min?: number;
    max?: number;
    allow_multiple_values?: boolean;
  };
  values?: { code: string; label: string }[];
}

export interface OlxCity {
  id: number;
  region_id: number;
  name: string;
  county?: string;
  municipality?: string;
  latitude?: number;
  longitude?: number;
}

export interface OlxDistrict {
  id: number;
  city_id: number;
  name: string;
}

export interface OlxCurrency {
  code: string;
  label: string;
  is_default?: boolean;
}

export interface OlxToken {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope?: string;
  /** ISO-время получения токена (добавляется при сохранении) */
  obtained_at: string;
}

export interface OlxValidationError {
  field?: string;
  title?: string;
  detail?: string;
}
