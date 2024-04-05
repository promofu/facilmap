/// <reference types="vite/client" />
import { type i18n } from "i18next";
import { defineComponent, ref } from "vue";
import messagesEn from "../../i18n/en.json";
import messagesDe from "../../i18n/de.json";
import messagesNbNo from "../../i18n/nb-NO.json";
import { decodeQueryString, getRawI18n, onI18nReady, setCurrentUnitsGetter } from "facilmap-utils";
import { cookies } from "./cookies";
import { unitsValidator } from "facilmap-types";

const namespace = "facilmap-frontend";

onI18nReady((i18n) => {
	i18n.addResourceBundle("en", namespace, messagesEn);
	i18n.addResourceBundle("de", namespace, messagesDe);
	i18n.addResourceBundle("nb-NO", namespace, messagesNbNo);
});

if (import.meta.hot) {
	const acceptHot = (lang: string) => (mod: any) => {
		if (mod) {
			onI18nReady((i18n) => {
				i18n.addResourceBundle(lang, namespace, mod!.default);
			});
		}
	};
	import.meta.hot!.accept(`../../i18n/en.json`, acceptHot("en"));
	import.meta.hot!.accept(`../../i18n/de.json`, acceptHot("de"));
	import.meta.hot!.accept(`../../i18n/nb-NO.json`, acceptHot("nb-NO"));
}

const i18nResourceChangeCounter = ref(0);
const onI18nResourceChange = () => {
	i18nResourceChangeCounter.value++;
};

onI18nReady((i18n) => {
	i18n.store.on("added", onI18nResourceChange);
	i18n.store.on("removed", onI18nResourceChange);
	i18n.on("languageChanged", onI18nResourceChange);
	i18n.on("loaded", onI18nResourceChange);

	let tBkp = i18n.t;
	i18n.t = function(this: any, ...args: any) {
		// Consume resource change counter to make calls to t() reactive to i18n resource changes
		i18nResourceChangeCounter.value;

		return tBkp.apply(this, args);
	} as any;
});

setCurrentUnitsGetter(() => {
	const queryParams = decodeQueryString(location.search);
	const query = queryParams.format ? unitsValidator.safeParse(queryParams.format) : undefined;
	return query?.success ? query.data : cookies.units;
});

export function getI18n(): {
	t: i18n["t"];
	changeLanguage: (lang: string) => Promise<void>;
} {
	return {
		t: getRawI18n().getFixedT(null, namespace),

		changeLanguage: async (lang) => {
			await getRawI18n().changeLanguage(lang);
		}
	};
}

export function useI18n(): ReturnType<typeof getI18n> {
	return getI18n();
}

/**
 * Renders a translated message. Each interpolation variable needs to be specified as a slot, making it possible to interpolate
 * components and rich text.
 */
export const T = defineComponent({
	props: {
		k: { type: String, required: true }
	},
	setup(props, { slots }) {
		const i18n = useI18n();

		return () => {
			const mappedSlots = Object.entries(slots).map(([name, slot], i) => ({ name, placeholder: `%___SLOT_${i}___%`, slot }));
			const placeholderByName = Object.fromEntries(mappedSlots.map(({ name, placeholder }) => [name, placeholder]));
			const slotByPlaceholder = Object.fromEntries(mappedSlots.map(({ placeholder, slot }) => [placeholder, slot]));
			const message = i18n.t(props.k, placeholderByName);
			return message.split(/(%___SLOT_\d+___%)/g).map((v, i) => {
				if (i % 2 === 0) {
					return v;
				} else {
					return slotByPlaceholder[v]!();
				}
			});
		};
	}
});