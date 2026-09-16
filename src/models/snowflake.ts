export const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

export function isSnowflake(value: string): boolean {
  return SNOWFLAKE_PATTERN.test(value);
}

export const CHANNEL_NAME_TEMPLATE_MAX = 100;
export const CHANNEL_NAME_TEMPLATE_MIN = 1;
export const DEFAULT_CHANNEL_NAME_TEMPLATE = "{username}'s channel";
