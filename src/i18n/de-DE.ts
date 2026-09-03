import { Translations } from "./types";

// German dictionary. Typed to the same shape as en-GB, so a missing or
// mistyped key fails the TypeScript build.
export const deDE: Translations = {
	"window.title": "Personalverwaltung",
	"menu.title": "Personalverwaltung",

	"parkEntrance.notFound": "Parkeingang: nicht gefunden.",
	"parkEntrance.summary": "{RED}P{BLACK} {0}  {RED}Q{BLACK} {1}  {RED}G{BLACK} {2}  {RED}E{BLACK} {3}  {RED}O{BLACK} {4}",
	"parkEntrance.tooltip": "Zusammenfassung der letzten Kartenabtastung: P = Wegfliesen, Q = Warteschlangenfliesen, G = Gartenfliesen, E = Fahrgeschäftsausgänge, O = Gesamtzahl der Grundstücksfliesen. Aktualisiert durch Personalanzahl anpassen/Zuweisen.",

	"applyMessage.tooltip": "Reserviert für Statusmeldungen nach Personalanzahl anpassen/Zuweisen.",
	"progress.tooltip": "Fortschritt des laufenden Vorgangs Personalanzahl anpassen/Zuweisen.",

	"auto.on": "Automatische Zuweisung ist AN",
	"auto.off": "Automatische Zuweisung ist AUS",
	"auto.tooltip": "Den Park automatisch neu scannen und Personal anpassen/zuweisen, sobald sich Wege, Fahrgeschäfte, Ausgänge oder der Parkeingang ändern.",

	"status.assigningHandymen": "Hausmeister werden zugewiesen...",
	"status.assigningGuards": "Wachleute werden zugewiesen...",
	"status.assigningEntertainers": "Entertainer werden zugewiesen...",
	"status.assigningMechanics": "Mechaniker werden zugewiesen...",
	"status.adjusting": "Personalanzahl wird angepasst...",
	"status.done": "Fertig",

	"button.adjustAndAssign": "Anpassen und zuweisen",
	"button.adjustAndAssign.tooltip": "Stellt Personal jedes aktivierten Typs ein oder entlässt es, um die berechnete Bedarfsanzahl zu erreichen (Einstellung bei Unterbesetzung, Entlassung der ältesten zuerst bei Überbesetzung) und baut anschließend die Patrouillenbereiche anhand der zuletzt gescannten Fliesen neu auf und teleportiert jedes Personalmitglied an den Anfang seines neuen Bereichs.",

	"staffGroup.enabled": "Aktiviert",
	"staffGroup.enabledTooltip": "Ob dieser Personaltyp von Personalanzahl anpassen und Zuweisen verwaltet wird. Deaktivieren schließt ihn vollständig von beiden Aktionen aus.",
	"staffGroup.handymen.title": "Hausmeister",
	"staffGroup.guards.title": "Wachen",
	"staffGroup.mechanics.title": "Mechaniker",
	"staffGroup.entertainers.title": "Maskottchen",
	"staffGroup.entertainers.enabledTooltip": "Ob Maskottchen von Personalanzahl anpassen und Zuweisen verwaltet werden. Deaktivieren schließt sie vollständig von beiden Aktionen aus.",

	"spinnerLabel.cleanup": "Reinigung",
	"spinnerLabel.gardening": "Gartenarbeit",
	"spinnerLabel.tilesPerStaff": "Fliesen / Personal",
	"spinnerLabel.staffPerArea": "Personal / Bereich",
	"checkbox.queue": "Warteschlange",

	"tooltip.handymenCleanupSpinner": "Die Anzahl der Weg-/Warteschlangenfliesen, die ein für Reinigung eingeteilter Hausmeister patrouillieren soll (Fliesen pro Personal). Wird verwendet, um zu berechnen, wie viele Reinigungs-Hausmeister benötigt werden.",
	"tooltip.handymenGardeningSpinner": "Die Anzahl der Gartenfliesen (Fliesen, die gemäht oder bewässert werden müssen), die ein für Gartenarbeit eingeteilter Hausmeister patrouillieren soll (Fliesen pro Personal). Wird verwendet, um zu berechnen, wie viele Garten-Hausmeister benötigt werden.",
	"tooltip.guardsSpinner": "Die Anzahl der einfachen Wegfliesen (ohne Warteschlangenfliesen), die eine Wache patrouillieren soll (Fliesen pro Personal). Wird verwendet, um zu berechnen, wie viele Wachen benötigt werden.",
	"tooltip.entertainersTilesSpinner": "Die Anzahl der Wegfliesen (und, falls das Warteschlangen-Kästchen aktiviert ist, Warteschlangenfliesen), die ein Maskottchen patrouillieren soll (Fliesen pro Personal). Wird verwendet, um zu berechnen, wie viele Maskottchen benötigt werden.",
	"tooltip.entertainersPerAreaSpinner": "Die Anzahl der Maskottchen, die pro Patrouillenbereich zugewiesen werden; mehr als 1 lässt Bereiche überlappen, damit die Fliesen-pro-Personal-Dichte erhalten bleibt.",
	"tooltip.entertainersQueueCheckbox": "Ob Maskottchen zusätzlich zu einfachen Wegfliesen auch Warteschlangenfliesen patrouillieren.",

	"statRow.hired": "Angestellt",
	"statRow.hired.tooltip": "Die Anzahl des derzeit im Park angestellten Personals dieses Typs.",
	"statRow.needed": "Benötigt",
	"statRow.needed.tooltip": "Die Anzahl des Personals dieses Typs, das benötigt wird, um das erreichbare Wegnetz zu patrouillieren, unter der Annahme, dass das Netz in aufeinanderfolgende (zusammenhängende) Abschnitte von jeweils \"Fliesen pro Personal\" Fliesen aufgeteilt wird.",
	"statRow.difference": "Differenz",
	"statRow.difference.tooltip": "Benötigt minus Angestellt: eine positive Zahl bedeutet, dass Personal dieses Typs eingestellt werden muss, eine negative Zahl bedeutet, dass Personal entlassen werden kann."
};
