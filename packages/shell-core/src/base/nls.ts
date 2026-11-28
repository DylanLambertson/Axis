// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// `localize` as the ported modules call it (OS-5): the key names the string for a later translation table, the
// message is the English text, and `{0}`, `{1}`, ... are replaced by the arguments. OS-6 owns translation; until then
// the English text is returned. A placeholder without an argument is left as it is.

export function localize(key: string, message: string, ...args: ReadonlyArray<string | number | boolean | undefined | null>): string {
  void key;
  return message.replace(/\{(\d+)\}/g, (whole, index: string) => {
    const arg = args[Number(index)];
    return arg === undefined || arg === null ? whole : String(arg);
  });
}
