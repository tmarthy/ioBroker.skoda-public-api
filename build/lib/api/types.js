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
var types_exports = {};
__export(types_exports, {
  COMMAND_DOMAINS: () => COMMAND_DOMAINS,
  VEHICLE_PARTS: () => VEHICLE_PARTS
});
module.exports = __toCommonJS(types_exports);
const VEHICLE_PARTS = [
  "info",
  "status",
  "fuelStatus",
  "odometer",
  "parkingPosition",
  "airConditioning",
  "auxiliaryHeating",
  "activeVentilation",
  "charging",
  "chargingProfiles"
];
const COMMAND_DOMAINS = ["charging", "air-conditioning", "auxiliary-heating", "active-ventilation"];
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  COMMAND_DOMAINS,
  VEHICLE_PARTS
});
//# sourceMappingURL=types.js.map
