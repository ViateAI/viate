import { getLocale, locales, setLocale } from "./paraglide/runtime.js";
import { m } from "./paraglide/messages.js";

const LOCALE_NAME: Record<(typeof locales)[number], string> = {
  en: "English",
  zh: "中文",
};

export function LocaleSwitch() {
  const current = getLocale();
  return (
    <div className="segmented locale-switch" role="group" aria-label={m.locale_group()}>
      {locales.map((locale) => (
        <button
          key={locale}
          type="button"
          aria-pressed={current === locale}
          onClick={() => {
            if (locale !== current) {
              setLocale(locale);
            }
          }}
        >
          {LOCALE_NAME[locale]}
        </button>
      ))}
    </div>
  );
}
