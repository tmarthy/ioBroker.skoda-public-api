/**
 * Lesbare Aliase auf die generierten OpenAPI-Typen.
 *
 * Diese Datei ist handgepflegt und der einzige Ort, an dem der Rest des Adapters
 * die Škoda-Datentypen bezieht. `schema.generated.ts` wird nirgends sonst importiert -
 * so bleibt ein Umbau des Codegens auf diese Datei beschränkt.
 */
import type { components, operations } from './schema.generated';

type Schemas = components['schemas'];

export type VehicleResponse = Schemas['VehicleResponse'];
export type Vehicle = Schemas['Vehicle'];
export type VehicleError = Schemas['VehicleError'];
export type ProblemDetail = Schemas['ProblemDetail'];

export type VehicleStatus = Schemas['VehicleStatus'];
export type OverallVehicleStatus = Schemas['OverallVehicleStatusDto'];
export type VehicleStatusDetail = Schemas['VehicleStatusDetailDto'];

export type FuelStatus = Schemas['FuelStatus'];
export type EngineRange = Schemas['EngineRange'];
export type Odometer = Schemas['Odometer'];
export type ParkingPosition = Schemas['ParkingPosition'];

export type AirConditioning = Schemas['AirConditioning'];
export type WindowHeating = Schemas['WindowHeating'];
export type AuxiliaryHeating = Schemas['AuxiliaryHeating'];
export type ActiveVentilation = Schemas['ActiveVentilation'];
export type TargetTemperature = Schemas['TargetTemperature'];

export type Charging = Schemas['Charging'];
export type ChargingStatus = Schemas['ChargingStatus'];
export type BatteryStatus = Schemas['BatteryStatus'];
export type ChargingSettings = Schemas['ChargingSettings'];
export type ChargingProfiles = Schemas['ChargingProfiles'];
export type ChargingProfile = Schemas['ChargingProfile'];
export type ChargingProfileSettings = Schemas['ChargingProfileSettings'];
export type ChargingTime = Schemas['ChargingTime'];
export type Timer = Schemas['Timer'];

export type StartAirConditioningConfiguration = Schemas['StartAirConditioningConfiguration'];
export type StartAuxiliaryHeatingConfiguration = Schemas['StartAuxiliaryHeatingConfiguration'];

/**
 * Zulässige Werte des `include`-Parameters. Ohne `include` liefert die API genau die
 * Teile, die das Fahrzeug unterstützt - das ist die eingebaute Fähigkeitserkennung
 * (siehe docs/design-decisions.md, E13).
 */
export type VehiclePart = NonNullable<NonNullable<operations['getVehicle']['parameters']['query']>['include']>[number];

export const VEHICLE_PARTS = [
	'info',
	'status',
	'fuelStatus',
	'odometer',
	'parkingPosition',
	'airConditioning',
	'auxiliaryHeating',
	'activeVentilation',
	'charging',
	'chargingProfiles',
] as const satisfies readonly VehiclePart[];

/** Die vier steuerbaren Domänen (je ein start-/stop-Endpunkt). */
export const COMMAND_DOMAINS = ['charging', 'air-conditioning', 'auxiliary-heating', 'active-ventilation'] as const;

export type CommandDomain = (typeof COMMAND_DOMAINS)[number];
export type CommandAction = 'start' | 'stop';
