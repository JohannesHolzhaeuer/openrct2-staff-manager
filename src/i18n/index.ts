/// <reference path="../../node_modules/@openrct2/types/openrct2.d.ts" />
import { Translations, TranslationKey } from "./types";
import { enGB } from "./en-GB";
import { deDE } from "./de-DE";

// Language code -> dictionary. Add a new language by copying en-GB.ts,
// translating every value, and registering it here.
export const translations: { [languageCode: string]: Translations } = {
	"en-GB": enGB,
	"de-DE": deDE
};

const FALLBACK_LANGUAGE = "en-GB";

// Resolves the player's UI language via context.configuration, falling back
// to en-GB on any failure (older API versions, missing key, unknown
// language, etc.) so the plugin never crashes or shows a blank UI.
function detectLanguage(): string {
	try {
		const language = context.configuration.get<string>("general.language", FALLBACK_LANGUAGE);
		if (language && translations[language]) {
			return language;
		}
	} catch {
		// Ignore - fall back to English below.
	}
	return FALLBACK_LANGUAGE;
}

// Resolved lazily (on every call, not cached) rather than at module load
// time: calling context.configuration at bundle-evaluation time - before the
// game has finished setting up the plugin - can throw in a way that aborts
// the whole script, which would prevent registerPlugin/the menu item from
// ever being registered. Re-resolving on every call (instead of caching the
// result after the first lookup) also means a language change made in the
// game's options takes effect the next time the window is (re)opened,
// without requiring a plugin reload.
function getDict(): Translations {
	const activeLanguage = detectLanguage();
	return translations[activeLanguage] || translations[FALLBACK_LANGUAGE];
}

// Typed translation helper. Supports positional placeholders {0}, {1}, ...
// for dynamic values (numbers/currency/dates should be formatted via
// context.formatString before being passed in). Falls back from the active
// language, to en-GB, to the raw key - it never throws or returns blank.
export function t(key: TranslationKey, ...args: (string | number)[]): string {
	const s = (getDict()[key] ?? translations[FALLBACK_LANGUAGE][key] ?? key) as string;
	return args.reduce<string>(
		(acc, a, i) => acc.replaceAll(`{${i}}`, String(a)),
		s
	);
}
