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
var parts_exports = {};
__export(parts_exports, {
  ERROR_REPORTING_PARTS: () => ERROR_REPORTING_PARTS,
  RENDER_UNAVAILABLE: () => RENDER_UNAVAILABLE,
  partErrorType: () => partErrorType,
  partFromErrorType: () => partFromErrorType
});
module.exports = __toCommonJS(parts_exports);
const PART_ERROR_PREFIX = {
  status: "VEHICLE_STATUS",
  fuelStatus: "FUEL_STATUS",
  odometer: "ODOMETER",
  parkingPosition: "PARKING_POSITION",
  airConditioning: "AIR_CONDITIONING",
  auxiliaryHeating: "AUXILIARY_HEATING",
  activeVentilation: "ACTIVE_VENTILATION",
  charging: "CHARGING",
  chargingProfiles: "CHARGING_PROFILES"
};
const RENDER_UNAVAILABLE = "RENDER_UNAVAILABLE";
function partErrorType(part, kind) {
  return `${PART_ERROR_PREFIX[part]}_${kind}`;
}
function partFromErrorType(errorType) {
  for (const [part, prefix] of Object.entries(PART_ERROR_PREFIX)) {
    for (const kind of ["UNSUPPORTED", "DISABLED", "UNAVAILABLE"]) {
      if (errorType === `${prefix}_${kind}`) {
        return part;
      }
    }
  }
  return void 0;
}
const ERROR_REPORTING_PARTS = Object.keys(PART_ERROR_PREFIX);
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ERROR_REPORTING_PARTS,
  RENDER_UNAVAILABLE,
  partErrorType,
  partFromErrorType
});
//# sourceMappingURL=parts.js.map
