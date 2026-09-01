"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var objectOverlay_exports = {};
__export(objectOverlay_exports, {
  exactOverlayPaths: () => exactOverlayPaths,
  resolveCommon: () => resolveCommon
});
module.exports = __toCommonJS(objectOverlay_exports);
const PERCENT = { role: "value.battery", unit: "%", min: 0, max: 100 };
const suffixOverlay = [
  // Ladezustand und Reichweite
  ["stateOfChargeInPercent", PERCENT],
  ["currentSoCInPercent", PERCENT],
  ["currentFuelLevelInPercent", { role: "value.fill", unit: "%", min: 0, max: 100 }],
  ["targetStateOfChargeInPercent", PERCENT],
  ["batteryCareModeTargetValueInPercent", PERCENT],
  ["chargePowerInKw", { role: "value.power", unit: "kW" }],
  ["chargingRateInKilometersPerHour", { role: "value.speed", unit: "km/h" }],
  ["maxChargeCurrentAcAmpere", { role: "value.current", unit: "A" }],
  ["remainingCruisingRangeInMeters", { role: "value.distance", unit: "m" }],
  ["remainingRangeInKm", { role: "value.distance", unit: "km" }],
  ["totalRangeInKm", { role: "value.distance", unit: "km" }],
  ["adBlueRange", { role: "value.distance", unit: "km" }],
  ["mileageInKm", { role: "value.distance", unit: "km" }],
  ["remainingTimeToFullyChargedInMinutes", { role: "value.interval", unit: "min" }],
  ["durationInSeconds", { role: "value.interval", unit: "s" }],
  // Zeitpunkte - bleiben als ISO-8601-Zeichenkette, wie die API sie liefert (E7).
  ["carCapturedTimestamp", { role: "date" }],
  ["fullyChargedAt", { role: "date" }],
  ["estimatedReachOfTargetTemperatureAt", { role: "date" }],
  ["nextChargingTime", { role: "date" }],
  // Position
  ["gpsCoordinates.latitude", { role: "value.gps.latitude", unit: "\xB0" }],
  ["gpsCoordinates.longitude", { role: "value.gps.longitude", unit: "\xB0" }],
  ["formattedAddress", { role: "text" }]
];
const exactOverlay = {
  vin: { role: "text" },
  name: { role: "text" },
  licensePlate: { role: "text" },
  renderUrl: { role: "url" },
  "status.overall.doorsLocked": {
    role: "sensor.lock",
    labels: {
      YES: "Locked",
      NO: "Unlocked",
      OPENED: "Door open",
      TRUNK_OPENED: "Trunk open",
      UNKNOWN: "Unknown"
    }
  },
  "status.overall.locked": {
    role: "sensor.lock",
    labels: { YES: "Locked", NO: "Unlocked", UNKNOWN: "Unknown" }
  },
  "status.overall.reliableLockStatus": { role: "sensor.lock" },
  "status.overall.doors": { role: "sensor.door" },
  "status.overall.windows": { role: "sensor.window" },
  "status.overall.lights": { role: "sensor.light" },
  "status.detail.sunroof": { role: "sensor.window" },
  "status.detail.trunk": { role: "sensor.door" },
  "status.detail.bonnet": { role: "sensor.door" },
  "charging.status.state": {
    role: "text",
    labels: {
      CONNECT_CABLE: "Cable not connected",
      READY_FOR_CHARGING: "Ready for charging",
      CHARGING: "Charging",
      CONSERVING: "Conserving",
      CHARGING_INTERRUPTED: "Charging interrupted",
      DISCHARGING: "Discharging"
    }
  },
  "charging.status.chargeType": { role: "text" },
  "charging.isVehicleInSavedLocation": { role: "indicator" },
  "charging.settings.availableChargeModes": { role: "json" },
  "airConditioning.state": {
    role: "text",
    labels: {
      OFF: "Off",
      COOLING: "Cooling",
      HEATING: "Heating",
      HEATING_AUXILIARY: "Auxiliary heating",
      VENTILATION: "Ventilation",
      COMPLETED: "Completed",
      UNKNOWN: "Unknown",
      UNSUPPORTED: "Not supported"
    }
  },
  // Einheit bewusst offen: die Skala steht im Geschwisterzustand `targetTemperature.unit`
  // (CELSIUS oder FAHRENHEIT). Der StateWriter setzt sie zur Laufzeit daraus.
  "airConditioning.targetTemperature.value": { role: "value.temperature" },
  "auxiliaryHeating.targetTemperature.value": { role: "value.temperature" },
  "airConditioning.airConditioningAtUnlock": { role: "indicator" },
  "airConditioning.airConditioningWithoutExternalPower": { role: "indicator" },
  "airConditioning.windowHeating.enabled": { role: "indicator" },
  "airConditioning.windowHeating.front": { role: "sensor.heat" },
  "airConditioning.windowHeating.rear": { role: "sensor.heat" },
  "parkingPosition.state": {
    role: "text",
    labels: { IN_MOTION: "In motion", PARKED: "Parked" }
  },
  "chargingProfiles.profiles": { role: "json" }
};
const exactOverlayPaths = Object.keys(exactOverlay);
function lookupOverlay(path) {
  const exact = exactOverlay[path];
  if (exact) {
    return exact;
  }
  for (const [suffix, entry] of suffixOverlay) {
    if (path === suffix || path.endsWith(`.${suffix}`)) {
      return entry;
    }
  }
  return void 0;
}
function defaultRole(def) {
  if (def.arrayOf || def.isJsonArray) {
    return "json";
  }
  if (def.format === "date-time") {
    return "date";
  }
  if (def.type === "boolean") {
    return "indicator";
  }
  if (def.states) {
    return "text";
  }
  return def.type === "number" ? "value" : "text";
}
function resolveCommon(path, def) {
  var _a, _b;
  const overlay = lookupOverlay(path);
  const common = {
    name: (_a = def.desc) != null ? _a : path,
    type: def.type,
    role: (_b = overlay == null ? void 0 : overlay.role) != null ? _b : defaultRole(def),
    read: true,
    write: false
  };
  if ((overlay == null ? void 0 : overlay.unit) !== void 0) {
    common.unit = overlay.unit;
  }
  if ((overlay == null ? void 0 : overlay.min) !== void 0) {
    common.min = overlay.min;
  }
  if ((overlay == null ? void 0 : overlay.max) !== void 0) {
    common.max = overlay.max;
  }
  if (def.states) {
    common.states = Object.fromEntries(
      Object.keys(def.states).map((value) => {
        var _a2, _b2;
        return [value, (_b2 = (_a2 = overlay == null ? void 0 : overlay.labels) == null ? void 0 : _a2[value]) != null ? _b2 : value];
      })
    );
  }
  return common;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  exactOverlayPaths,
  resolveCommon
});
//# sourceMappingURL=objectOverlay.js.map
