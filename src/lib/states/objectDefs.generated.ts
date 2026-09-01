/**
 * GENERIERT - nicht von Hand editieren.
 * Quelle: spec/skoda-openapi.json
 * Erzeugen mit: npm run codegen
 *
 * Pfade sind relativ zum Geraeteknoten (der VIN) und spiegeln die JSON-Struktur
 * der API 1:1 (siehe docs/design-decisions.md, E7).
 */

export interface GeneratedStateDef {
	/** ioBroker-Datentyp. */
	type: 'number' | 'string' | 'boolean';
	/** Aufzaehlungswerte, sofern die Spec welche nennt - Wert auf Wert abgebildet. */
	states?: Record<string, string>;
	/** OpenAPI-Format, z.B. 'date-time'. */
	format?: string;
	/** Liste primitiver Werte: wird als JSON-String abgelegt. */
	isJsonArray?: boolean;
	/** Objektliste: Sonderbehandlung im StateWriter, Wert ist der Schemaname. */
	arrayOf?: string;
	/** Gekuerzte Beschreibung aus der Spec. */
	desc?: string;
}

/** Zwischenknoten des Objektbaums (ioBroker-Kanaele). */
export const generatedChannels: Record<string, string> = {
	"activeVentilation": "Information about the vehicle's active ventilation.",
	"airConditioning": "Information about the vehicle's air conditioning.",
	"airConditioning.targetTemperature": "Target cabin temperature.",
	"airConditioning.windowHeating": "State of the electric window heating.",
	"auxiliaryHeating": "Information about the vehicle's auxiliary (fuel-operated or electric) heater.",
	"auxiliaryHeating.targetTemperature": "Target cabin temperature.",
	"charging": "Charging and battery status of the vehicle. Returned only for vehicles that support charging - battery-electric vehicles and plug-in hybrids. Vehicles without a",
	"charging.settings": "Information about charging settings.",
	"charging.status": "Charging status information.",
	"charging.status.battery": "Battery status information.",
	"chargingProfiles": "Charging profiles (saved charging locations) defined for the vehicle. When explicitly requested (via `include`) for a vehicle that does not support them, `charg",
	"chargingProfiles.currentVehiclePositionProfile": "Information about the profile where the vehicle is currently located. Only returned if the vehicle is positioned in any profile.",
	"fuelStatus": "Fuel status and driving range of the vehicle. Returned only for vehicles with a combustion engine, including hybrids. Battery-electric vehicles do not report fu",
	"fuelStatus.primaryEngineRange": "Details of the vehicle's engine range.",
	"fuelStatus.secondaryEngineRange": "Details of the vehicle's engine range.",
	"odometer": "Current odometer reading of the vehicle. When explicitly requested (via `include`) for a vehicle that does not support it, `odometer` is omitted and `errors` co",
	"parkingPosition": "Last known parking position of the vehicle. When explicitly requested (via `include`) for a vehicle that does not support it, `parkingPosition` is omitted and `",
	"parkingPosition.gpsCoordinates": "GPS coordinates of the vehicle parking position. Only present when `state` is `PARKED`.",
	"status": "Current status of the vehicle's doors, windows and lights - an aggregated `overall` view plus per-part `detail`. When explicitly requested (via `include`) for a",
	"status.detail": "VehicleStatusDetailDto",
	"status.overall": "OverallVehicleStatusDto"
};

export const generatedStateDefs: Record<string, GeneratedStateDef> = {
	"activeVentilation.carCapturedTimestamp": {
		"type": "string",
		"format": "date-time",
		"desc": "Timestamp when the data was last captured and sent by the vehicle. Standard ISO 8601 format."
	},
	"activeVentilation.durationInSeconds": {
		"type": "number",
		"format": "int32",
		"desc": "Duration in seconds the active ventilation runs for when started."
	},
	"activeVentilation.state": {
		"type": "string",
		"states": {
			"OFF": "OFF",
			"PREHEATING": "PREHEATING",
			"VENTILATION": "VENTILATION",
			"UNKNOWN": "UNKNOWN",
			"UNSUPPORTED": "UNSUPPORTED"
		},
		"desc": "State of the active ventilation."
	},
	"airConditioning.airConditioningAtUnlock": {
		"type": "boolean",
		"desc": "Setting indicating whether the air conditioning starts automatically when the vehicle is unlocked."
	},
	"airConditioning.airConditioningWithoutExternalPower": {
		"type": "boolean",
		"desc": "Setting indicating whether the air conditioning may run without the vehicle being connected to an external power source."
	},
	"airConditioning.carCapturedTimestamp": {
		"type": "string",
		"format": "date-time",
		"desc": "Timestamp when the data was last captured and sent by the vehicle. Standard ISO 8601 format."
	},
	"airConditioning.estimatedReachOfTargetTemperatureAt": {
		"type": "string",
		"format": "date-time",
		"desc": "Timestamp when the cabin is expected to reach the target temperature. Standard ISO 8601 format."
	},
	"airConditioning.state": {
		"type": "string",
		"states": {
			"OFF": "OFF",
			"COOLING": "COOLING",
			"HEATING": "HEATING",
			"HEATING_AUXILIARY": "HEATING_AUXILIARY",
			"VENTILATION": "VENTILATION",
			"COMPLETED": "COMPLETED",
			"UNKNOWN": "UNKNOWN",
			"UNSUPPORTED": "UNSUPPORTED"
		},
		"desc": "State of the air conditioning."
	},
	"airConditioning.targetTemperature.unit": {
		"type": "string",
		"states": {
			"CELSIUS": "CELSIUS",
			"FAHRENHEIT": "FAHRENHEIT"
		},
		"desc": "Temperature unit."
	},
	"airConditioning.targetTemperature.value": {
		"type": "number",
		"format": "double",
		"desc": "Target temperature value, in the unit given by `unit`."
	},
	"airConditioning.windowHeating.enabled": {
		"type": "boolean",
		"desc": "True if window heating is enabled for the vehicle. Absent when the vehicle did not report its climatisation settings."
	},
	"airConditioning.windowHeating.front": {
		"type": "string",
		"states": {
			"ON": "ON",
			"OFF": "OFF",
			"UNKNOWN": "UNKNOWN",
			"UNSUPPORTED": "UNSUPPORTED"
		},
		"desc": "State of the front window heating."
	},
	"airConditioning.windowHeating.rear": {
		"type": "string",
		"states": {
			"ON": "ON",
			"OFF": "OFF",
			"UNKNOWN": "UNKNOWN",
			"UNSUPPORTED": "UNSUPPORTED"
		},
		"desc": "State of the rear window heating."
	},
	"auxiliaryHeating.carCapturedTimestamp": {
		"type": "string",
		"format": "date-time",
		"desc": "Timestamp when the data was last captured and sent by the vehicle. Standard ISO 8601 format."
	},
	"auxiliaryHeating.durationInSeconds": {
		"type": "number",
		"format": "int32",
		"desc": "Duration in seconds the auxiliary heating runs for when started."
	},
	"auxiliaryHeating.estimatedReachOfTargetTemperatureAt": {
		"type": "string",
		"format": "date-time",
		"desc": "Timestamp when the cabin is expected to reach the target temperature. Standard ISO 8601 format."
	},
	"auxiliaryHeating.startMode": {
		"type": "string",
		"states": {
			"HEATING": "HEATING",
			"VENTILATION": "VENTILATION"
		},
		"desc": "Mode the auxiliary heating starts in."
	},
	"auxiliaryHeating.state": {
		"type": "string",
		"states": {
			"OFF": "OFF",
			"PREHEATING": "PREHEATING",
			"HEATING_AUXILIARY": "HEATING_AUXILIARY",
			"VENTILATION": "VENTILATION",
			"UNKNOWN": "UNKNOWN",
			"UNSUPPORTED": "UNSUPPORTED"
		},
		"desc": "State of the auxiliary heating."
	},
	"auxiliaryHeating.targetTemperature.unit": {
		"type": "string",
		"states": {
			"CELSIUS": "CELSIUS",
			"FAHRENHEIT": "FAHRENHEIT"
		},
		"desc": "Temperature unit."
	},
	"auxiliaryHeating.targetTemperature.value": {
		"type": "number",
		"format": "double",
		"desc": "Target temperature value, in the unit given by `unit`."
	},
	"charging.carCapturedTimestamp": {
		"type": "string",
		"format": "date-time",
		"desc": "Timestamp when the data was last captured and sent by the vehicle. Standard ISO 8601 format."
	},
	"charging.isVehicleInSavedLocation": {
		"type": "boolean",
		"desc": "Indicates whether the vehicle is in a saved location (a specific location with defined charging settings)."
	},
	"charging.settings.autoUnlockPlugWhenCharged": {
		"type": "string",
		"states": {
			"PERMANENT": "PERMANENT",
			"OFF": "OFF"
		},
		"desc": "Value for auto unlock plug, when charging is finished."
	},
	"charging.settings.availableChargeModes": {
		"type": "string",
		"isJsonArray": true,
		"desc": "List of available charging modes."
	},
	"charging.settings.batteryCareModeTargetValueInPercent": {
		"type": "number",
		"format": "int32",
		"desc": "Recommended target state of charge in percent when battery care mode is enabled."
	},
	"charging.settings.chargingCareMode": {
		"type": "string",
		"states": {
			"ACTIVATED": "ACTIVATED",
			"DEACTIVATED": "DEACTIVATED"
		},
		"desc": "Indicates whether is charging care mode activated."
	},
	"charging.settings.maxChargeCurrentAc": {
		"type": "string",
		"states": {
			"REDUCED": "REDUCED",
			"MAXIMUM": "MAXIMUM"
		},
		"desc": "Value that should be used when start charging."
	},
	"charging.settings.maxChargeCurrentAcAmpere": {
		"type": "number",
		"format": "int32",
		"desc": "Maximum charging current limit in ampere. Can acquire values 5, 10, 13 or 32."
	},
	"charging.settings.preferredChargeMode": {
		"type": "string",
		"states": {
			"MANUAL": "MANUAL",
			"TIMER": "TIMER",
			"TIMER_CHARGING_WITH_CLIMATISATION": "TIMER_CHARGING_WITH_CLIMATISATION",
			"PREFERRED_CHARGING_TIMES": "PREFERRED_CHARGING_TIMES",
			"ONLY_OWN_CURRENT": "ONLY_OWN_CURRENT",
			"IMMEDIATE_DISCHARGING": "IMMEDIATE_DISCHARGING",
			"HOME_STORAGE_CHARGING": "HOME_STORAGE_CHARGING"
		},
		"desc": "Preferred charging mode."
	},
	"charging.settings.targetStateOfChargeInPercent": {
		"type": "number",
		"format": "int32",
		"desc": "Target state of charge in percent."
	},
	"charging.status.battery.remainingCruisingRangeInMeters": {
		"type": "number",
		"format": "int32",
		"desc": "Remaining cruising range with HV battery power in meters."
	},
	"charging.status.battery.stateOfChargeInPercent": {
		"type": "number",
		"format": "int32",
		"desc": "State of charge in percent."
	},
	"charging.status.chargePowerInKw": {
		"type": "number",
		"format": "double",
		"desc": "Charge power in kilowatts."
	},
	"charging.status.chargeType": {
		"type": "string",
		"states": {
			"AC": "AC",
			"DC": "DC",
			"OFF": "OFF"
		},
		"desc": "Type of charging."
	},
	"charging.status.chargingRateInKilometersPerHour": {
		"type": "number",
		"format": "double",
		"desc": "Rate of charging in kilometers per hour."
	},
	"charging.status.fullyChargedAt": {
		"type": "string",
		"format": "date-time",
		"desc": "Timestamp when the vehicle is expected to be fully charged"
	},
	"charging.status.remainingTimeToFullyChargedInMinutes": {
		"type": "number",
		"format": "int32",
		"desc": "Remaining charging time to complete in minutes."
	},
	"charging.status.state": {
		"type": "string",
		"states": {
			"CONNECT_CABLE": "CONNECT_CABLE",
			"CHARGING": "CHARGING",
			"CONSERVING": "CONSERVING",
			"READY_FOR_CHARGING": "READY_FOR_CHARGING",
			"DISCHARGING": "DISCHARGING",
			"CHARGING_INTERRUPTED": "CHARGING_INTERRUPTED"
		},
		"desc": "Charging state."
	},
	"chargingProfiles.carCapturedTimestamp": {
		"type": "string",
		"format": "date-time",
		"desc": "Timestamp when the data was last captured and sent by the vehicle. Standard ISO 8601 format."
	},
	"chargingProfiles.currentVehiclePositionProfile.id": {
		"type": "number",
		"format": "int64",
		"desc": "Identifier of profile."
	},
	"chargingProfiles.currentVehiclePositionProfile.name": {
		"type": "string",
		"desc": "The name of the charging profile as specified by the user."
	},
	"chargingProfiles.currentVehiclePositionProfile.nextChargingTime": {
		"type": "string",
		"desc": "Specifies next charging time which will be triggered at current profile. Time is in vehicle local in ISO 8601 format (HH:mm)."
	},
	"chargingProfiles.currentVehiclePositionProfile.targetStateOfChargeInPercent": {
		"type": "number",
		"format": "int32",
		"desc": "Target charging level in percent set by user for this profile."
	},
	"chargingProfiles.profiles": {
		"type": "string",
		"arrayOf": "ChargingProfile"
	},
	"fuelStatus.adBlueRange": {
		"type": "number",
		"desc": "Vehicle's adBlue range in kilometers. Available only for vehicles with diesel engine."
	},
	"fuelStatus.carCapturedTimestamp": {
		"type": "string",
		"format": "date-time",
		"desc": "Timestamp when the data was last captured and sent by the vehicle. Standard ISO 8601 format."
	},
	"fuelStatus.carType": {
		"type": "string",
		"states": {
			"HYBRID": "HYBRID",
			"GASOLINE": "GASOLINE",
			"DIESEL": "DIESEL",
			"CNG": "CNG",
			"LPG": "LPG",
			"UNKNOWN": "UNKNOWN"
		},
		"desc": "Vehicle's type."
	},
	"fuelStatus.primaryEngineRange.currentFuelLevelInPercent": {
		"type": "number",
		"desc": "Vehicle's fuel level in percent."
	},
	"fuelStatus.primaryEngineRange.currentSoCInPercent": {
		"type": "number",
		"desc": "Vehicle's State of Charge in percent."
	},
	"fuelStatus.primaryEngineRange.engineType": {
		"type": "string",
		"states": {
			"ELECTRIC": "ELECTRIC",
			"GASOLINE": "GASOLINE",
			"DIESEL": "DIESEL",
			"CNG": "CNG",
			"LPG": "LPG",
			"UNKNOWN": "UNKNOWN"
		},
		"desc": "Vehicle's engine type."
	},
	"fuelStatus.primaryEngineRange.remainingRangeInKm": {
		"type": "number",
		"desc": "Vehicle's remaining range in kilometers."
	},
	"fuelStatus.secondaryEngineRange.currentFuelLevelInPercent": {
		"type": "number",
		"desc": "Vehicle's fuel level in percent."
	},
	"fuelStatus.secondaryEngineRange.currentSoCInPercent": {
		"type": "number",
		"desc": "Vehicle's State of Charge in percent."
	},
	"fuelStatus.secondaryEngineRange.engineType": {
		"type": "string",
		"states": {
			"ELECTRIC": "ELECTRIC",
			"GASOLINE": "GASOLINE",
			"DIESEL": "DIESEL",
			"CNG": "CNG",
			"LPG": "LPG",
			"UNKNOWN": "UNKNOWN"
		},
		"desc": "Vehicle's engine type."
	},
	"fuelStatus.secondaryEngineRange.remainingRangeInKm": {
		"type": "number",
		"desc": "Vehicle's remaining range in kilometers."
	},
	"fuelStatus.totalRangeInKm": {
		"type": "number",
		"desc": "Vehicle's total range in kilometers."
	},
	"licensePlate": {
		"type": "string"
	},
	"name": {
		"type": "string",
		"desc": "User-defined vehicle name. When the user has not named the vehicle, the model name (e.g. `Enyaq`) is returned instead."
	},
	"odometer.carCapturedTimestamp": {
		"type": "string",
		"format": "date-time",
		"desc": "Timestamp when the data was last captured and sent by the vehicle. Standard ISO 8601 format."
	},
	"odometer.mileageInKm": {
		"type": "number",
		"format": "int64",
		"desc": "Current mileage of the vehicle in kilometers."
	},
	"parkingPosition.formattedAddress": {
		"type": "string",
		"desc": "Formatted address of the vehicle parking position: Street, House Number, Zip Code, City, Country. Only present when `state` is `PARKED`, and omitted when the ad"
	},
	"parkingPosition.gpsCoordinates.latitude": {
		"type": "number",
		"format": "double",
		"desc": "Latitude coordinate."
	},
	"parkingPosition.gpsCoordinates.longitude": {
		"type": "number",
		"format": "double",
		"desc": "Longitude coordinate."
	},
	"parkingPosition.state": {
		"type": "string",
		"states": {
			"IN_MOTION": "IN_MOTION",
			"PARKED": "PARKED"
		},
		"desc": "State of the vehicle from parking position point of view."
	},
	"renderUrl": {
		"type": "string",
		"format": "uri"
	},
	"status.carCapturedTimestamp": {
		"type": "string",
		"format": "date-time",
		"desc": "Timestamp when the data was last captured and sent by the vehicle. Standard ISO 8601 format."
	},
	"status.detail.bonnet": {
		"type": "string",
		"states": {
			"OPEN": "OPEN",
			"CLOSED": "CLOSED",
			"UNKNOWN": "UNKNOWN"
		},
		"desc": "Possible value is OPEN, CLOSED, UNKNOWN."
	},
	"status.detail.sunroof": {
		"type": "string",
		"states": {
			"OPEN": "OPEN",
			"CLOSED": "CLOSED",
			"UNKNOWN": "UNKNOWN",
			"UNSUPPORTED": "UNSUPPORTED"
		},
		"desc": "Possible value is OPEN, CLOSED, UNKNOWN or UNSUPPORTED."
	},
	"status.detail.trunk": {
		"type": "string",
		"states": {
			"OPEN": "OPEN",
			"CLOSED": "CLOSED",
			"UNKNOWN": "UNKNOWN"
		},
		"desc": "Possible value is OPEN, CLOSED, UNKNOWN."
	},
	"status.overall.doors": {
		"type": "string",
		"states": {
			"OPEN": "OPEN",
			"CLOSED": "CLOSED",
			"UNKNOWN": "UNKNOWN"
		},
		"desc": "Possible values are: * OPEN - any supported door is OPEN. * CLOSED - at least one door is supported AND all supported doors are CLOSED. * UNKNOWN - system canno"
	},
	"status.overall.doorsLocked": {
		"type": "string",
		"states": {
			"YES": "YES",
			"NO": "NO",
			"OPENED": "OPENED",
			"TRUNK_OPENED": "TRUNK_OPENED",
			"UNKNOWN": "UNKNOWN"
		},
		"desc": "Overall doors and trunk lock state."
	},
	"status.overall.lights": {
		"type": "string",
		"states": {
			"ON": "ON",
			"OFF": "OFF",
			"UNKNOWN": "UNKNOWN"
		},
		"desc": "Possible values are: * ON - at least one supported light is ON. * OFF - all supported lights are OFF. * UNKNOWN - system cannot recognise correct value."
	},
	"status.overall.locked": {
		"type": "string",
		"states": {
			"YES": "YES",
			"NO": "NO",
			"UNKNOWN": "UNKNOWN"
		},
		"desc": "Possible values are: * YES - at least one door is supported AND all supported doors and trunk are LOCKED+CLOSED. * NO - any supported door is UNLOCKED/OPEN and "
	},
	"status.overall.reliableLockStatus": {
		"type": "string",
		"states": {
			"LOCKED": "LOCKED",
			"UNLOCKED": "UNLOCKED",
			"UNKNOWN": "UNKNOWN"
		},
		"desc": "Provides information if vehicle is locked. Unlocked value is returned only for MOD4 vehicles."
	},
	"status.overall.windows": {
		"type": "string",
		"states": {
			"OPEN": "OPEN",
			"CLOSED": "CLOSED",
			"UNKNOWN": "UNKNOWN",
			"UNSUPPORTED": "UNSUPPORTED"
		},
		"desc": "Aggregated over the side windows; the sunroof is excluded and reported separately in `detail`."
	},
	"vin": {
		"type": "string",
		"desc": "Vehicle Identification Number."
	}
};
