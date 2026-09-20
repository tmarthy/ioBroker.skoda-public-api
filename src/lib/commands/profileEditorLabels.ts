/** Object labels and descriptions for the local profile editor. */
import { OBJECT_NAME_LANGUAGES, type CompleteObjectName } from '../i18n';

/**
 * Build a complete translation object in the standard ioBroker language order.
 *
 * @param values English, German, Russian, Portuguese, Dutch, French, Italian, Spanish, Polish, Ukrainian, Chinese.
 */
function label(
	...values: [string, string, string, string, string, string, string, string, string, string, string]
): CompleteObjectName {
	const result = Object.fromEntries(
		OBJECT_NAME_LANGUAGES.map((language, index) => [language, values[index]]),
	) as CompleteObjectName;

	return result;
}

export const EDITOR_LABELS = {
	maxChargingCurrent: label(
		'Maximum charging current',
		'Maximaler Ladestrom',
		'Максимальный ток зарядки',
		'Corrente máxima de carregamento',
		'Maximale laadstroom',
		'Courant de charge maximal',
		'Corrente massima di ricarica',
		'Corriente máxima de carga',
		'Maksymalny prąd ładowania',
		'Максимальний струм заряджання',
		'最大充电电流',
	),
	minBatteryStateOfCharge: label(
		'Minimum battery charge',
		'Mindestladestand',
		'Минимальный заряд батареи',
		'Carga mínima da bateria',
		'Minimale acculading',
		'Charge minimale de la batterie',
		'Carica minima della batteria',
		'Carga mínima de la batería',
		'Minimalny poziom baterii',
		'Мінімальний заряд батареї',
		'最低电池电量',
	),
	minimumBatteryStateOfChargeInPercent: label(
		'Minimum battery charge (%)',
		'Mindestladestand (%)',
		'Минимальный заряд батареи (%)',
		'Carga mínima da bateria (%)',
		'Minimale acculading (%)',
		'Charge minimale de la batterie (%)',
		'Carica minima della batteria (%)',
		'Carga mínima de la batería (%)',
		'Minimalny poziom baterii (%)',
		'Мінімальний заряд батареї (%)',
		'最低电池电量 (%)',
	),
	timers: label(
		'Departure timers',
		'Abfahrtszeitpläne',
		'Таймеры отправления',
		'Temporizadores de partida',
		'Vertrektimers',
		'Programmations de départ',
		'Timer di partenza',
		'Temporizadores de salida',
		'Harmonogramy wyjazdu',
		'Таймери виїзду',
		'出发定时器',
	),
	preferredChargingTimes: label(
		'Preferred charging times',
		'Bevorzugte Ladezeiten',
		'Предпочтительное время зарядки',
		'Horários de carregamento preferidos',
		'Voorkeurslaadtijden',
		'Horaires de recharge préférés',
		'Orari di ricarica preferiti',
		'Horarios de carga preferidos',
		'Preferowane godziny ładowania',
		'Бажаний час заряджання',
		'首选充电时间',
	),
	type: label(
		'Timer type',
		'Zeitplantyp',
		'Тип таймера',
		'Tipo de temporizador',
		'Timertype',
		'Type de programmation',
		'Tipo di timer',
		'Tipo de temporizador',
		'Typ harmonogramu',
		'Тип таймера',
		'定时器类型',
	),
	time: label(
		'Departure time',
		'Abfahrtszeit',
		'Время отправления',
		'Hora de partida',
		'Vertrektijd',
		'Heure de départ',
		'Ora di partenza',
		'Hora de salida',
		'Godzina wyjazdu',
		'Час виїзду',
		'出发时间',
	),
	oneOffDay: label(
		'Day for one-off timer',
		'Tag für einmaligen Zeitplan',
		'День разового таймера',
		'Dia do temporizador único',
		'Dag voor eenmalige timer',
		'Jour de programmation unique',
		'Giorno del timer singolo',
		'Día del temporizador único',
		'Dzień jednorazowego harmonogramu',
		'День одноразового таймера',
		'单次定时日期',
	),
	recurringOn: label(
		'Repeat on weekdays',
		'Wiederholung an Wochentagen',
		'Повторять по дням недели',
		'Repetir nos dias da semana',
		'Herhalen op weekdagen',
		'Répéter les jours de la semaine',
		'Ripeti nei giorni della settimana',
		'Repetir los días de la semana',
		'Powtarzaj w dni tygodnia',
		'Повторювати за днями тижня',
		'按星期重复',
	),
	startTime: label(
		'Start time',
		'Beginn',
		'Время начала',
		'Hora de início',
		'Begintijd',
		'Heure de début',
		'Ora di inizio',
		'Hora de inicio',
		'Godzina rozpoczęcia',
		'Час початку',
		'开始时间',
	),
	endTime: label(
		'End time',
		'Ende',
		'Время окончания',
		'Hora de fim',
		'Eindtijd',
		'Heure de fin',
		'Ora di fine',
		'Hora de fin',
		'Godzina zakończenia',
		'Час завершення',
		'结束时间',
	),
	available: label(
		'Profile available for editing',
		'Profil zur Bearbeitung verfügbar',
		'Профиль доступен для редактирования',
		'Perfil disponível para edição',
		'Profiel beschikbaar voor bewerking',
		'Profil disponible pour modification',
		'Profilo disponibile per la modifica',
		'Perfil disponible para editar',
		'Profil dostępny do edycji',
		'Профіль доступний для редагування',
		'配置可编辑',
	),
};

export const EDITOR_CHOICES = {
	REDUCED: label(
		'Reduced',
		'Reduziert',
		'Пониженный',
		'Reduzida',
		'Verlaagd',
		'Réduit',
		'Ridotta',
		'Reducida',
		'Obniżony',
		'Знижений',
		'降低',
	),
	MAXIMUM: label(
		'Maximum',
		'Maximal',
		'Максимальный',
		'Máxima',
		'Maximaal',
		'Maximal',
		'Massima',
		'Máxima',
		'Maksymalny',
		'Максимальний',
		'最大',
	),
	PERMANENT: label(
		'Enabled permanently',
		'Dauerhaft aktiviert',
		'Включено постоянно',
		'Sempre ativado',
		'Permanent ingeschakeld',
		'Activé en permanence',
		'Sempre attivo',
		'Siempre activado',
		'Stale włączone',
		'Увімкнено постійно',
		'始终启用',
	),
	OFF: label(
		'Off',
		'Aus',
		'Выключено',
		'Desligado',
		'Uit',
		'Désactivé',
		'Disattivato',
		'Desactivado',
		'Wyłączone',
		'Вимкнено',
		'关闭',
	),
	ONE_OFF: label(
		'Once',
		'Einmalig',
		'Однократно',
		'Uma vez',
		'Eenmalig',
		'Une fois',
		'Una volta',
		'Una vez',
		'Jednorazowo',
		'Одноразово',
		'单次',
	),
	RECURRING: label(
		'Recurring',
		'Wiederkehrend',
		'Повторяющийся',
		'Recorrente',
		'Terugkerend',
		'Récurrent',
		'Ricorrente',
		'Recurrente',
		'Cyklicznie',
		'Повторюваний',
		'重复',
	),
	'': label(
		'Not selected',
		'Nicht ausgewählt',
		'Не выбрано',
		'Não selecionado',
		'Niet geselecteerd',
		'Non sélectionné',
		'Non selezionato',
		'No seleccionado',
		'Nie wybrano',
		'Не вибрано',
		'未选择',
	),
};

export const EDITOR_DESCRIPTIONS = {
	field: label(
		'Local draft. Apply sends all changes together; acknowledgement means locally stored.',
		'Lokaler Entwurf. Übernehmen sendet alle Änderungen gemeinsam; die Quittierung bedeutet lokal gespeichert.',
		'Локальный черновик. Применение отправляет все изменения; подтверждение означает локальное сохранение.',
		'Rascunho local. Aplicar envia todas as alterações; a confirmação indica armazenamento local.',
		'Lokaal concept. Toepassen verstuurt alle wijzigingen; bevestiging betekent lokaal opgeslagen.',
		'Brouillon local. Appliquer envoie toutes les modifications ; l’accusé indique un stockage local.',
		'Bozza locale. Applica invia tutte le modifiche; la conferma indica il salvataggio locale.',
		'Borrador local. Aplicar envía todos los cambios; la confirmación indica almacenamiento local.',
		'Lokalny szkic. Zastosuj wysyła wszystkie zmiany; potwierdzenie oznacza zapis lokalny.',
		'Локальна чернетка. Застосування надсилає всі зміни; підтвердження означає локальне збереження.',
		'本地草稿。应用会一起发送所有更改；确认表示已存储在本地。',
	),
	time: label(
		'HH:mm in vehicle local time. Apply sends the draft.',
		'HH:mm in Fahrzeug-Ortszeit. Übernehmen sendet den Entwurf.',
		'ЧЧ:мм по местному времени автомобиля. Примените для отправки.',
		'HH:mm na hora local do veículo. Aplicar envia o rascunho.',
		'HH:mm in lokale voertuigtijd. Toepassen verstuurt het concept.',
		'HH:mm en heure locale du véhicule. Appliquer envoie le brouillon.',
		'HH:mm nell’ora locale del veicolo. Applica invia la bozza.',
		'HH:mm en la hora local del vehículo. Aplicar envía el borrador.',
		'GG:mm w lokalnym czasie pojazdu. Zastosuj wysyła szkic.',
		'ГГ:хх за місцевим часом автомобіля. Застосування надсилає чернетку.',
		'HH:mm，车辆当地时间。应用会发送草稿。',
	),
	unavailable: label(
		'Unavailable in current vehicle data. Value retained; editing disabled until the field returns.',
		'In aktuellen Fahrzeugdaten nicht verfügbar. Wert bleibt erhalten; Bearbeitung bis zur Rückkehr deaktiviert.',
		'Недоступно в текущих данных автомобиля. Значение сохранено; редактирование отключено до возвращения поля.',
		'Indisponível nos dados atuais. Valor mantido; edição desativada até o campo regressar.',
		'Niet beschikbaar in huidige voertuiggegevens. Waarde bewaard; bewerken uitgeschakeld tot het veld terugkeert.',
		'Indisponible dans les données actuelles. Valeur conservée ; modification désactivée jusqu’au retour du champ.',
		'Non disponibile nei dati attuali. Valore conservato; modifica disabilitata fino al ritorno del campo.',
		'No disponible en los datos actuales. Valor conservado; edición desactivada hasta que vuelva el campo.',
		'Niedostępne w aktualnych danych. Wartość zachowana; edycja wyłączona do powrotu pola.',
		'Недоступно в поточних даних. Значення збережено; редагування вимкнено до повернення поля.',
		'当前车辆数据中不可用。保留数值；字段恢复前禁止编辑。',
	),
	apply: label(
		'Validate and submit the complete draft through the command queue. See command confirmation for the outcome.',
		'Vollständigen Entwurf prüfen und über die Befehlswarteschlange senden. Ergebnis unter Befehlsbestätigung.',
		'Проверить и отправить весь черновик через очередь команд. Результат — в подтверждении команды.',
		'Validar e enviar o rascunho completo pela fila de comandos. Consulte a confirmação do comando.',
		'Volledig concept controleren en via de opdrachtwachtrij versturen. Zie opdrachtbevestiging voor het resultaat.',
		'Valider et envoyer le brouillon complet via la file de commandes. Voir la confirmation de commande.',
		'Verifica e invia la bozza completa tramite la coda dei comandi. Vedi conferma del comando.',
		'Validar y enviar el borrador completo mediante la cola de comandos. Consulte la confirmación del comando.',
		'Sprawdź i wyślij cały szkic przez kolejkę poleceń. Wynik w potwierdzeniu polecenia.',
		'Перевірити й надіслати всю чернетку через чергу команд. Результат у підтвердженні команди.',
		'验证并通过命令队列发送完整草稿。结果见命令确认。',
	),
	reset: label(
		'Discard local edits and use the last polled profile. No vehicle request.',
		'Lokale Änderungen verwerfen und zuletzt gelesenes Profil verwenden. Keine Fahrzeugabfrage.',
		'Отменить локальные изменения и использовать последний полученный профиль. Без запроса к автомобилю.',
		'Descartar alterações locais e usar o último perfil lido. Sem pedido ao veículo.',
		'Lokale wijzigingen wissen en laatst gelezen profiel gebruiken. Geen voertuigverzoek.',
		'Annuler les modifications locales et utiliser le dernier profil lu. Aucune requête au véhicule.',
		'Scarta modifiche locali e usa l’ultimo profilo letto. Nessuna richiesta al veicolo.',
		'Descartar cambios locales y usar el último perfil leído. Sin solicitudes al vehículo.',
		'Odrzuć lokalne zmiany i użyj ostatnio odczytanego profilu. Bez zapytania do pojazdu.',
		'Скасувати локальні зміни й використати останній отриманий профіль. Без запиту до автомобіля.',
		'放弃本地更改并使用最近读取的配置。不会请求车辆。',
	),
};

const weekdayCache = new Map<string, CompleteObjectName>();
const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];

/**
 * Translate weekday names with the runtime's standard locale data.
 *
 * @param key API weekday identifier.
 */
export function weekdayLabel(key: string): CompleteObjectName | undefined {
	const cached = weekdayCache.get(key);
	if (cached) {
		return cached;
	}
	const index = DAYS.indexOf(key);
	if (index < 0) {
		return undefined;
	}
	const result = Object.fromEntries(
		OBJECT_NAME_LANGUAGES.map(language => [
			language,
			new Intl.DateTimeFormat(language, { weekday: 'long', timeZone: 'UTC' }).format(
				new Date(Date.UTC(2024, 0, 1 + index)),
			),
		]),
	) as CompleteObjectName;
	weekdayCache.set(key, result);
	return result;
}
