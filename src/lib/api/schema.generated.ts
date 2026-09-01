/* eslint-disable */
/**
 * GENERIERT - nicht von Hand editieren.
 * Quelle: spec/skoda-openapi.json
 * Erzeugen mit: npm run codegen
 */
export interface paths {
    "/api/v1/vehicles/{vin}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Returns the vehicle and its current state.
         * @description The endpoint delivers the vehicle together with its current state: status (doors, windows, lights), fuel status, odometer, air conditioning (including auxiliary heating and active ventilation), charging, charging profiles (saved charging locations) and parking position. The response can be limited to selected parts of the data using the `include` query parameter.
         */
        get: operations["getVehicle"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/vehicles/{vin}/active-ventilation/start": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Start active ventilation inside the desired vehicle. */
        post: operations["startActiveVentilation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/vehicles/{vin}/active-ventilation/stop": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Stop active ventilation inside the desired vehicle. */
        post: operations["stopActiveVentilation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/vehicles/{vin}/air-conditioning/start": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Starts an air-conditioning process inside a vehicle to reach the target temperature. */
        post: operations["startAirConditioning"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/vehicles/{vin}/air-conditioning/stop": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Stops an air-conditioning process inside a vehicle. */
        post: operations["stopAirConditioning"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/vehicles/{vin}/auxiliary-heating/start": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Start auxiliary heating inside the desired vehicle. */
        post: operations["startAuxiliaryHeating"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/vehicles/{vin}/auxiliary-heating/stop": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Stop auxiliary heating inside the desired vehicle. */
        post: operations["stopAuxiliaryHeating"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/vehicles/{vin}/charging/start": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Start charging for a given vehicle. */
        post: operations["startCharging"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/vehicles/{vin}/charging/stop": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Stop charging for a given vehicle. */
        post: operations["stopCharging"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /** @description Information about the vehicle's active ventilation. */
        ActiveVentilation: {
            /**
             * Format: date-time
             * @description Timestamp when the data was last captured and sent by the vehicle. Standard ISO 8601 format.
             * @example 2021-06-01T12:00Z
             */
            carCapturedTimestamp?: string;
            /**
             * Format: int32
             * @description Duration in seconds the active ventilation runs for when started.
             * @example 600
             */
            durationInSeconds?: number;
            /**
             * @description State of the active ventilation. Possible values are:   * OFF   * PREHEATING   * VENTILATION   * UNKNOWN - system cannot recognise correct value   * UNSUPPORTED - the vehicle does not report this state
             * @example VENTILATION
             */
            state: string;
        };
        /** @description Information about the vehicle's air conditioning. */
        AirConditioning: {
            /**
             * @description Setting indicating whether the air conditioning starts automatically when the vehicle is unlocked.
             * @example false
             */
            airConditioningAtUnlock?: boolean;
            /**
             * @description Setting indicating whether the air conditioning may run without the vehicle being connected to an external power source.
             * @example true
             */
            airConditioningWithoutExternalPower?: boolean;
            /**
             * Format: date-time
             * @description Timestamp when the data was last captured and sent by the vehicle. Standard ISO 8601 format.
             * @example 2021-06-01T12:00Z
             */
            carCapturedTimestamp?: string;
            /**
             * Format: date-time
             * @description Timestamp when the cabin is expected to reach the target temperature. Standard ISO 8601 format.
             * @example 2026-06-12T07:30Z
             */
            estimatedReachOfTargetTemperatureAt?: string;
            /**
             * @description State of the air conditioning. Possible values are:   * OFF   * COOLING   * HEATING   * HEATING_AUXILIARY - the auxiliary heater is assisting with heating the cabin   * VENTILATION   * COMPLETED   * UNKNOWN - system cannot recognise correct value   * UNSUPPORTED - the vehicle does not report this state
             * @example HEATING
             */
            state: string;
            targetTemperature?: components["schemas"]["TargetTemperature"];
            windowHeating?: components["schemas"]["WindowHeating"];
        };
        /** @description Information about the vehicle's auxiliary (fuel-operated or electric) heater. */
        AuxiliaryHeating: {
            /**
             * Format: date-time
             * @description Timestamp when the data was last captured and sent by the vehicle. Standard ISO 8601 format.
             * @example 2021-06-01T12:00Z
             */
            carCapturedTimestamp?: string;
            /**
             * Format: int32
             * @description Duration in seconds the auxiliary heating runs for when started.
             * @example 600
             */
            durationInSeconds?: number;
            /**
             * Format: date-time
             * @description Timestamp when the cabin is expected to reach the target temperature. Standard ISO 8601 format.
             * @example 2026-06-12T07:30Z
             */
            estimatedReachOfTargetTemperatureAt?: string;
            /**
             * @description Mode the auxiliary heating starts in. Possible values are:   * HEATING   * VENTILATION
             * @example HEATING
             */
            startMode?: string;
            /**
             * @description State of the auxiliary heating. Possible values are:   * OFF   * PREHEATING   * HEATING_AUXILIARY   * VENTILATION   * UNKNOWN - system cannot recognise correct value   * UNSUPPORTED - the vehicle does not report this state
             * @example HEATING_AUXILIARY
             */
            state: string;
            targetTemperature?: components["schemas"]["TargetTemperature"];
        };
        /** @description Battery status information. */
        BatteryStatus: {
            /**
             * Format: int32
             * @description Remaining cruising range with HV battery power in meters.
             * @example 249
             */
            remainingCruisingRangeInMeters?: number;
            /**
             * Format: int32
             * @description State of charge in percent.
             * @example 71
             */
            stateOfChargeInPercent?: number;
        };
        /** @description Charging and battery status of the vehicle. Returned only for vehicles that support charging - battery-electric vehicles and plug-in hybrids. Vehicles without a high-voltage battery do not report charging. When explicitly requested (via `include`) for a vehicle that does not support it, `charging` is omitted and `errors` contains `CHARGING_UNSUPPORTED`. Likewise, a supported but currently disabled charging service is reported via `CHARGING_DISABLED`. */
        Charging: {
            /**
             * Format: date-time
             * @description Timestamp when the data was last captured and sent by the vehicle. Standard ISO 8601 format.
             * @example 2021-06-01T12:00Z
             */
            carCapturedTimestamp?: string;
            /**
             * @description Indicates whether the vehicle is in a saved location (a specific location with defined charging settings).
             * @example true
             */
            isVehicleInSavedLocation: boolean;
            settings?: components["schemas"]["ChargingSettings"];
            status?: components["schemas"]["ChargingStatus"];
        };
        /** @description Information about a charging profile. */
        ChargingProfile: {
            /**
             * Format: int64
             * @description Identifier of this profile.
             * @example 123456
             */
            id: number;
            /**
             * @description The name of the charging profile as specified by the user.
             * @example charging profile 1
             */
            name: string;
            preferredChargingTimes: components["schemas"]["ChargingTime"][];
            settings: components["schemas"]["ChargingProfileSettings"];
            timers: components["schemas"]["Timer"][];
        };
        /** @description Charging profiles (saved charging locations) defined for the vehicle. When explicitly requested (via `include`) for a vehicle that does not support them, `chargingProfiles` is omitted and `errors` contains `CHARGING_PROFILES_UNSUPPORTED`. Likewise, supported but currently disabled charging profiles are reported via `CHARGING_PROFILES_DISABLED`, and profiles that could not be retrieved via `CHARGING_PROFILES_UNAVAILABLE`. */
        ChargingProfiles: {
            /**
             * Format: date-time
             * @description Timestamp when the data was last captured and sent by the vehicle. Standard ISO 8601 format.
             * @example 2021-06-01T12:00Z
             */
            carCapturedTimestamp?: string;
            currentVehiclePositionProfile?: components["schemas"]["CurrentVehiclePositionProfile"];
            profiles: components["schemas"]["ChargingProfile"][];
        };
        /** @description Charging profile settings. */
        ChargingProfileSettings: {
            /**
             * @description Value for auto unlock plug, when charging is finished. Possible values are:   * PERMANENT   * OFF
             * @example PERMANENT
             */
            autoUnlockPlugWhenCharged?: string;
            /**
             * @description Value that should be used when start charging. Possible values are:   * REDUCED   * MAXIMUM
             * @example MAXIMUM
             */
            maxChargingCurrent?: string;
            minBatteryStateOfCharge?: components["schemas"]["MinBatteryStateOfCharge"];
            /**
             * Format: int32
             * @description Target charging level in percent set by user.
             * @example 80
             */
            targetStateOfChargeInPercent?: number;
        };
        /** @description Information about charging settings. */
        ChargingSettings: {
            /**
             * @description Value for auto unlock plug, when charging is finished. Possible values are:   * PERMANENT   * OFF New values may be added over time, so clients must tolerate values they do not recognize.
             * @example PERMANENT
             */
            autoUnlockPlugWhenCharged?: string;
            /** @description List of available charging modes. Possible values are:   * MANUAL   * TIMER   * TIMER_CHARGING_WITH_CLIMATISATION   * PREFERRED_CHARGING_TIMES   * ONLY_OWN_CURRENT   * IMMEDIATE_DISCHARGING   * HOME_STORAGE_CHARGING New values may be added over time, so clients must tolerate values they do not recognize. */
            availableChargeModes?: string[];
            /**
             * Format: int32
             * @description Recommended target state of charge in percent when battery care mode is enabled.
             * @example 80
             */
            batteryCareModeTargetValueInPercent?: number;
            /**
             * @description Indicates whether is charging care mode activated. Possible values are:   * ACTIVATED   * DEACTIVATED New values may be added over time, so clients must tolerate values they do not recognize.
             * @example ACTIVATED
             */
            chargingCareMode?: string;
            /**
             * @description Value that should be used when start charging. Possible values are:   * REDUCED   * MAXIMUM New values may be added over time, so clients must tolerate values they do not recognize.
             * @example MAXIMUM
             */
            maxChargeCurrentAc?: string;
            /**
             * Format: int32
             * @description Maximum charging current limit in ampere. Can acquire values 5, 10, 13 or 32.
             * @example 10
             */
            maxChargeCurrentAcAmpere?: number;
            /**
             * @description Preferred charging mode. Possible values are:   * MANUAL   * TIMER   * TIMER_CHARGING_WITH_CLIMATISATION   * PREFERRED_CHARGING_TIMES   * ONLY_OWN_CURRENT   * IMMEDIATE_DISCHARGING   * HOME_STORAGE_CHARGING New values may be added over time, so clients must tolerate values they do not recognize.
             * @example MANUAL
             */
            preferredChargeMode?: string;
            /**
             * Format: int32
             * @description Target state of charge in percent.
             * @example 80
             */
            targetStateOfChargeInPercent?: number;
        };
        /** @description Charging status information. */
        ChargingStatus: {
            battery?: components["schemas"]["BatteryStatus"];
            /**
             * Format: double
             * @description Charge power in kilowatts.
             * @example 20.16960863831928
             */
            chargePowerInKw?: number;
            /**
             * @description Type of charging. Possible values are:   * AC   * DC   * OFF New values may be added over time, so clients must tolerate values they do not recognize.
             * @example DC
             */
            chargeType?: string;
            /**
             * Format: double
             * @description Rate of charging in kilometers per hour.
             * @example 20.16960863831928
             */
            chargingRateInKilometersPerHour?: number;
            /**
             * Format: date-time
             * @description Timestamp when the vehicle is expected to be fully charged
             */
            fullyChargedAt?: string;
            /**
             * Format: int32
             * @description Remaining charging time to complete in minutes.
             * @example 15
             */
            remainingTimeToFullyChargedInMinutes?: number;
            /**
             * @description Charging state. Possible values are:   * CONNECT_CABLE   * CHARGING   * CONSERVING   * READY_FOR_CHARGING   * DISCHARGING   * CHARGING_INTERRUPTED
             * @example READY_FOR_CHARGING
             */
            state?: string;
        };
        /** @description Preferred charging time when charging should be performed. */
        ChargingTime: {
            /**
             * @description Indicates if this preferred charging time is enabled.
             * @example true
             */
            enabled: boolean;
            /**
             * @description Specifies when the preferred charging time should stop. Local time in vehicle in ISO 8601 format (HH:mm).
             * @example 12:34
             */
            endTime: string;
            /**
             * Format: int64
             * @description Identifier of this charging time.
             * @example 123
             */
            id: number;
            /**
             * @description Specifies when the preferred charging time should start. Local time in vehicle in ISO 8601 format (HH:mm).
             * @example 12:34
             */
            startTime: string;
        };
        /** @description Information about the profile where the vehicle is currently located. Only returned if the vehicle is positioned in any profile. */
        CurrentVehiclePositionProfile: {
            /**
             * Format: int64
             * @description Identifier of profile.
             * @example 123456
             */
            id: number;
            /**
             * @description The name of the charging profile as specified by the user.
             * @example HOME
             */
            name: string;
            /**
             * @description Specifies next charging time which will be triggered at current profile. Time is in vehicle local in ISO 8601 format (HH:mm).
             * @example 12:34
             */
            nextChargingTime?: string;
            /**
             * Format: int32
             * @description Target charging level in percent set by user for this profile.
             * @example 80
             */
            targetStateOfChargeInPercent?: number;
        };
        /** @description Details of the vehicle's engine range. */
        EngineRange: {
            /**
             * @description Vehicle's fuel level in percent.
             * @example 87
             */
            currentFuelLevelInPercent?: number;
            /**
             * @description Vehicle's State of Charge in percent.
             * @example 100
             */
            currentSoCInPercent?: number;
            /**
             * @description Vehicle's engine type. Possible values are `ELECTRIC`, `GASOLINE`, `DIESEL`, `CNG`, `LPG` and `UNKNOWN`. New values may be added over time, so clients must tolerate values they do not recognize.
             * @example GASOLINE
             */
            engineType?: string;
            /**
             * @description Vehicle's remaining range in kilometers.
             * @example 350
             */
            remainingRangeInKm?: number;
        };
        /** @description Fuel status and driving range of the vehicle. Returned only for vehicles with a combustion engine, including hybrids. Battery-electric vehicles do not report fuel status - their range and state of charge are part of `charging`. When explicitly requested (via `include`) for a vehicle that does not support it, `fuelStatus` is omitted and `errors` contains `FUEL_STATUS_UNSUPPORTED`. Likewise, a supported but currently disabled fuel status is reported via `FUEL_STATUS_DISABLED`. */
        FuelStatus: {
            /**
             * @description Vehicle's adBlue range in kilometers. Available only for vehicles with diesel engine.
             * @example 1520
             */
            adBlueRange?: number;
            /**
             * Format: date-time
             * @description Timestamp when the data was last captured and sent by the vehicle. Standard ISO 8601 format.
             * @example 2021-06-01T12:00Z
             */
            carCapturedTimestamp?: string;
            /**
             * @description Vehicle's type. Possible values are `HYBRID`, `GASOLINE`, `DIESEL`, `CNG`, `LPG` and `UNKNOWN`. New values may be added over time, so clients must tolerate values they do not recognize.
             * @example GASOLINE
             */
            carType?: string;
            primaryEngineRange?: components["schemas"]["EngineRange"];
            secondaryEngineRange?: components["schemas"]["EngineRange"];
            /**
             * @description Vehicle's total range in kilometers.
             * @example 520
             */
            totalRangeInKm?: number;
        };
        /** @description Enables immediate charging regardless on charging profile, if battery is below specified level. */
        MinBatteryStateOfCharge: {
            /**
             * @description True if this feature is enabled.
             * @example true
             */
            enabled?: boolean;
            /**
             * Format: int32
             * @description If battery drop below this value, then start immediate charging.
             * @example 50
             */
            minimumBatteryStateOfChargeInPercent?: number;
        };
        /** @description Current odometer reading of the vehicle. When explicitly requested (via `include`) for a vehicle that does not support it, `odometer` is omitted and `errors` contains `ODOMETER_UNSUPPORTED`. Likewise, a supported but currently disabled odometer reading is reported via `ODOMETER_DISABLED`, and a reading that could not be retrieved via `ODOMETER_UNAVAILABLE`. */
        Odometer: {
            /**
             * Format: date-time
             * @description Timestamp when the data was last captured and sent by the vehicle. Standard ISO 8601 format.
             * @example 2021-06-01T12:00Z
             */
            carCapturedTimestamp?: string;
            /**
             * Format: int64
             * @description Current mileage of the vehicle in kilometers.
             * @example 12753
             */
            mileageInKm: number;
        };
        OverallVehicleStatusDto: {
            /**
             * @description Possible values are:   * OPEN - any supported door is OPEN.   * CLOSED - at least one door is supported AND all supported doors are CLOSED.   * UNKNOWN - system cannot recognise correct value.
             * @example OPEN
             */
            doors: string;
            /**
             * @description Overall doors and trunk lock state. Possible values are:   * YES - all supported doors AND trunk are LOCKED+CLOSED.   * NO - at least one supported door OR trunk is UNLOCKED but CLOSED.   * OPENED - at least one supported door OR bonnet is OPEN.   * TRUNK_OPENED - trunk is OPEN but all supported doors AND trunk are CLOSED.   * UNKNOWN - system cannot recognise correct value.
             * @example YES
             */
            doorsLocked: string;
            /**
             * @description Possible values are:   * ON - at least one supported light is ON.   * OFF - all supported lights are OFF.   * UNKNOWN - system cannot recognise correct value.
             * @example ON
             */
            lights: string;
            /**
             * @description Possible values are:   * YES - at least one door is supported AND all supported doors and trunk are LOCKED+CLOSED.   * NO - any supported door is UNLOCKED/OPEN and no door is UNKNOWN.   * UNKNOWN - system cannot recognise correct value.
             * @example YES
             */
            locked: string;
            /**
             * @description Provides information if vehicle is locked. Unlocked value is returned only for MOD4 vehicles. Possible values are:   * LOCKED - all supported doors AND trunk are LOCKED+CLOSED.   * UNLOCKED - any supported door is UNLOCKED/OPEN and no door is UNKNOWN.   * UNKNOWN - system cannot recognise correct value.
             * @example LOCKED
             */
            reliableLockStatus?: string;
            /**
             * @description Aggregated over the side windows; the sunroof is excluded and reported separately in `detail`. Possible values are:   * OPEN - any supported side window is OPEN.   * CLOSED - at least one window is supported AND all supported windows are CLOSED.   * UNKNOWN - system cannot recognise correct value.   * UNSUPPORTED - vehicle does not have all electric windows.
             * @example OPEN
             */
            windows: string;
        };
        /** @description Last known parking position of the vehicle. When explicitly requested (via `include`) for a vehicle that does not support it, `parkingPosition` is omitted and `errors` contains `PARKING_POSITION_UNSUPPORTED`. Likewise, a supported but currently disabled parking position is reported via `PARKING_POSITION_DISABLED`. When there is no last known parking position - typically because the vehicle is in motion - the response carries only `state` `IN_MOTION`, without coordinates or address. When the position cannot be retrieved, `parkingPosition` is omitted and `errors` contains `PARKING_POSITION_UNAVAILABLE`. */
        ParkingPosition: {
            /**
             * @description Formatted address of the vehicle parking position: Street, House Number, Zip Code, City, Country. Only present when `state` is `PARKED`, and omitted when the address could not be resolved.
             * @example Prazska 4A, 10200 Prague, Czech Republic
             */
            formattedAddress?: string;
            gpsCoordinates?: components["schemas"]["ParkingPosition_gpsCoordinates"];
            /**
             * @description State of the vehicle from parking position point of view. Possible values are: [IN_MOTION, PARKED]
             * @example PARKED
             */
            state: string;
        };
        /** @description GPS coordinates of the vehicle parking position. Only present when `state` is `PARKED`. */
        ParkingPosition_gpsCoordinates: {
            /**
             * Format: double
             * @description Latitude coordinate.
             * @example 37.4224428
             */
            latitude: number;
            /**
             * Format: double
             * @description Longitude coordinate.
             * @example -122.0842467
             */
            longitude: number;
        };
        /** @description Problem detail object as standardized by RFC 9457 (Problem Details for HTTP APIs). */
        ProblemDetail: {
            /**
             * @description Human-readable explanation specific to this occurrence of the problem.
             * @example The API key expired on 2026-09-01T00:00:00Z.
             */
            detail?: string;
            /**
             * @description URI reference identifying this specific occurrence of the problem.
             * @example /api/v1/vehicles/TMBJB9NY5RF999999
             */
            instance?: string;
            /**
             * Format: int32
             * @description HTTP status code of this occurrence of the problem.
             * @example 401
             */
            status?: number;
            /**
             * @description Short, human-readable summary of the problem type.
             * @example Unauthorized
             */
            title?: string;
            /**
             * @description URI reference identifying the problem type. Generic problems that carry no semantics beyond their HTTP status code use `about:blank`. More specific problem types are:   * https://public.api.connect.skoda-auto.cz/problems/api-key-expired - the API key used to authenticate has expired and must be rotated.   * https://public.api.connect.skoda-auto.cz/problems/api-key-not-authorized - the API key is not authorized to execute the operation.   * https://public.api.connect.skoda-auto.cz/problems/operation-not-authorized - the vehicle refused the operation for the user the API key belongs to.   * https://public.api.connect.skoda-auto.cz/problems/operation-not-supported - the vehicle lacks the capability the operation needs.   * https://public.api.connect.skoda-auto.cz/problems/operation-disabled - the capability the operation needs is currently disabled for the vehicle.   * https://public.api.connect.skoda-auto.cz/problems/rate-limit-exceeded - the rate limit for the API key has been exceeded.   * https://public.api.connect.skoda-auto.cz/problems/vehicle-not-accepting-requests - the vehicle declined the operation and it can be retried later.
             * @example https://public.api.connect.skoda-auto.cz/problems/api-key-expired
             */
            type?: string;
        };
        /** @description Configuration for starting the air conditioning of the vehicle. */
        StartAirConditioningConfiguration: {
            /**
             * @description Allow or forbid air conditioning when no external power connection is available.
             * @example true
             */
            airConditioningWithoutExternalPower?: boolean;
            targetTemperature?: components["schemas"]["TargetTemperature"];
        };
        /** @description Configuration with details needed for starting auxiliary heating. */
        StartAuxiliaryHeatingConfiguration: {
            /**
             * Format: int32
             * @description Duration in seconds the auxiliary heating runs for.
             * @example 120
             */
            durationInSeconds?: number;
            /**
             * @description Security PIN code.
             * @example 1234
             */
            spin: string;
            /**
             * @description Start mode of the auxiliary heating device. Possible values are:   * HEATING   * VENTILATION
             * @example HEATING
             */
            startMode?: string;
            targetTemperature?: components["schemas"]["TargetTemperature"];
        };
        /** @description Target cabin temperature. */
        TargetTemperature: {
            /**
             * @description Temperature unit. Possible values are:   * CELSIUS   * FAHRENHEIT
             * @example CELSIUS
             */
            unit: string;
            /**
             * Format: double
             * @description Target temperature value, in the unit given by `unit`.
             * @example 22.5
             */
            value: number;
        };
        /** @description Charging timer. */
        Timer: {
            /**
             * @description Is timer enabled.
             * @example true
             */
            enabled: boolean;
            /**
             * Format: int64
             * @description Timer identifier.
             * @example 123
             */
            id: number;
            /**
             * @description Day in week when ONE_OFF timer is required. ONE_OFF timer only.
             * @example MONDAY
             * @enum {string}
             */
            oneOffDay?: "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY";
            recurringOn?: ("MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY")[];
            /**
             * @description Time of start this timer in ISO 8601 format (HH:mm).
             * @example 12:34
             */
            time?: string;
            /**
             * @description Type of timer. Possible values are:   * ONE_OFF - one time timer   * RECURRING - timer repeating on days you choose
             * @example RECURRING
             */
            type: string;
        };
        /** @description The vehicle and its current state. */
        Vehicle: {
            activeVentilation?: components["schemas"]["ActiveVentilation"];
            airConditioning?: components["schemas"]["AirConditioning"];
            auxiliaryHeating?: components["schemas"]["AuxiliaryHeating"];
            charging?: components["schemas"]["Charging"];
            chargingProfiles?: components["schemas"]["ChargingProfiles"];
            fuelStatus?: components["schemas"]["FuelStatus"];
            /** @example 1MB 1234 */
            licensePlate?: string;
            /**
             * @description User-defined vehicle name. When the user has not named the vehicle, the model name (e.g. `Enyaq`) is returned instead.
             * @example My Enyaq
             */
            name?: string;
            odometer?: components["schemas"]["Odometer"];
            parkingPosition?: components["schemas"]["ParkingPosition"];
            /**
             * Format: uri
             * @example https://www.example.com/render
             */
            renderUrl?: string;
            status?: components["schemas"]["VehicleStatus"];
            /**
             * @description Vehicle Identification Number.
             * @example TMBJB9NY5RF999999
             */
            vin?: string;
        };
        /** @description Describes a part of the vehicle data that could not be retrieved, is not supported, or is currently disabled. `*_UNSUPPORTED` errors are only reported for parts explicitly requested via the `include` parameter; when `include` is omitted, unsupported parts are simply absent without an error. */
        VehicleError: {
            /**
             * @description Detail information about what and why happened.
             * @example Charging status could not be retrieved from the vehicle.
             */
            description?: string;
            /**
             * @description Machine-readable error type identifying the part of the response that is affected. Possible values are:   * RENDER_UNAVAILABLE - the vehicle render image URL could not be retrieved; name and licensePlate are unaffected   * VEHICLE_STATUS_UNSUPPORTED - vehicle status (doors, windows, lights, ...) is not supported   * VEHICLE_STATUS_DISABLED - vehicle status (doors, windows, lights, ...) is supported, but currently disabled   * VEHICLE_STATUS_UNAVAILABLE - vehicle status (doors, windows, lights, ...) could not be retrieved   * FUEL_STATUS_UNSUPPORTED - fuel status is not supported (for example a battery-electric vehicle)   * FUEL_STATUS_DISABLED - fuel status is supported, but currently disabled   * FUEL_STATUS_UNAVAILABLE - fuel status could not be retrieved   * ODOMETER_UNSUPPORTED - odometer reading is not supported   * ODOMETER_DISABLED - odometer reading is supported, but currently disabled   * ODOMETER_UNAVAILABLE - odometer reading could not be retrieved   * PARKING_POSITION_UNSUPPORTED - parking position is not supported   * PARKING_POSITION_DISABLED - parking position is supported, but currently disabled   * PARKING_POSITION_UNAVAILABLE - parking position could not be retrieved   * AIR_CONDITIONING_UNSUPPORTED - air conditioning information is not supported   * AIR_CONDITIONING_DISABLED - air conditioning information is supported, but currently disabled   * AIR_CONDITIONING_UNAVAILABLE - air conditioning information could not be retrieved   * AUXILIARY_HEATING_UNSUPPORTED - auxiliary heating information is not supported   * AUXILIARY_HEATING_DISABLED - auxiliary heating information is supported, but currently disabled   * AUXILIARY_HEATING_UNAVAILABLE - auxiliary heating information could not be retrieved   * ACTIVE_VENTILATION_UNSUPPORTED - active ventilation information is not supported   * ACTIVE_VENTILATION_DISABLED - active ventilation information is supported, but currently disabled   * ACTIVE_VENTILATION_UNAVAILABLE - active ventilation information could not be retrieved   * CHARGING_UNSUPPORTED - charging status is not supported   * CHARGING_DISABLED - charging status is supported, but currently disabled   * CHARGING_UNAVAILABLE - charging status could not be retrieved   * CHARGING_PROFILES_UNSUPPORTED - charging profiles are not supported   * CHARGING_PROFILES_DISABLED - charging profiles are supported, but currently disabled   * CHARGING_PROFILES_UNAVAILABLE - charging profiles could not be retrieved
             * @example CHARGING_UNAVAILABLE
             */
            type: string;
        };
        /** @description The vehicle with all available data, and a summary of errors that occurred while the data was gathered. */
        VehicleResponse: {
            /** @description Errors encountered while gathering the vehicle data. The response combines data from multiple sources; if some of them fail, the response contains partial data and the affected parts are omitted, each described by an error in this list. Parts that the vehicle does not support, or that it supports but are currently disabled, are reported the same way. */
            errors?: components["schemas"]["VehicleError"][];
            vehicle: components["schemas"]["Vehicle"];
        };
        /** @description Current status of the vehicle's doors, windows and lights - an aggregated `overall` view plus per-part `detail`. When explicitly requested (via `include`) for a vehicle that does not support it, `status` is omitted and `errors` contains `VEHICLE_STATUS_UNSUPPORTED`. Likewise, a supported but currently disabled vehicle status is reported via `VEHICLE_STATUS_DISABLED`, and a status that could not be retrieved via `VEHICLE_STATUS_UNAVAILABLE`. */
        VehicleStatus: {
            /**
             * Format: date-time
             * @description Timestamp when the data was last captured and sent by the vehicle. Standard ISO 8601 format.
             * @example 2021-06-01T12:00Z
             */
            carCapturedTimestamp?: string;
            detail: components["schemas"]["VehicleStatusDetailDto"];
            overall: components["schemas"]["OverallVehicleStatusDto"];
        };
        VehicleStatusDetailDto: {
            /**
             * @description Possible value is OPEN, CLOSED, UNKNOWN.
             * @example OPEN
             */
            bonnet: string;
            /**
             * @description Possible value is OPEN, CLOSED, UNKNOWN or UNSUPPORTED.
             * @example OPEN
             */
            sunroof: string;
            /**
             * @description Possible value is OPEN, CLOSED, UNKNOWN.
             * @example OPEN
             */
            trunk: string;
        };
        /** @description State of the electric window heating. */
        WindowHeating: {
            /**
             * @description True if window heating is enabled for the vehicle. Absent when the vehicle did not report its climatisation settings.
             * @example true
             */
            enabled?: boolean;
            /**
             * @description State of the front window heating. Possible values are:   * ON   * OFF   * UNKNOWN - system cannot recognise correct value   * UNSUPPORTED - vehicle does not support front window heating
             * @example ON
             */
            front?: string;
            /**
             * @description State of the rear window heating. Possible values are:   * ON   * OFF   * UNKNOWN - system cannot recognise correct value   * UNSUPPORTED - vehicle does not support rear window heating
             * @example OFF
             */
            rear?: string;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    getVehicle: {
        parameters: {
            query?: {
                /** @description Limits the response to the selected parts of the vehicle data, as a comma-separated list. Each value corresponds to the part of the response with the same name, except `info` which covers the basic vehicle information (`name`, `licensePlate` and `renderUrl`). The `vin` is always returned, regardless of this parameter.  When the parameter is omitted, all parts supported by the vehicle are returned. Parts the vehicle does not support are simply absent in that case - `*_UNSUPPORTED` errors are only reported for parts explicitly requested via this parameter. Unknown values are rejected with a `400 Bad Request` response.  A part that is not included is absent from the response. Note that an included part may also be absent when its data could not be retrieved - in that case the response contains a corresponding error in the `errors` list. */
                include?: ("info" | "status" | "fuelStatus" | "odometer" | "parkingPosition" | "airConditioning" | "auxiliaryHeating" | "activeVentilation" | "charging" | "chargingProfiles")[];
            };
            header?: never;
            path: {
                /** @description Unique VIN of the vehicle. */
                vin: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The vehicle and its current state. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VehicleResponse"];
                    "application/problem+json": components["schemas"]["VehicleResponse"];
                };
            };
            /** @description Bad request (e.g. an unknown `include` value or a malformed request body). When a request parameter is rejected, the problem carries the extension members `parameter`, `rejectedValue` and `allowedValues` identifying what to fix. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProblemDetail"];
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Unauthorized. If the API key has expired the problem type is https://public.api.connect.skoda-auto.cz/problems/api-key-expired. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProblemDetail"];
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Forbidden. The API key is not allowed to execute the operation; the problem type is https://public.api.connect.skoda-auto.cz/problems/api-key-not-authorized. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProblemDetail"];
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description No vehicle found for the given VIN. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProblemDetail"];
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Too many requests; retry after the period indicated by the `Retry-After` header. The `type` member tells the two possible causes apart:   * https://public.api.connect.skoda-auto.cz/problems/rate-limit-exceeded - the rate limit for the API key has been exceeded.   * https://public.api.connect.skoda-auto.cz/problems/vehicle-not-accepting-requests - the vehicle itself declined the operation, for example to limit how often it executes requests or because its battery level is too low.  The `RateLimit-*` headers describe the quota on every response, so they do not tell the two apart - the request that uses up the last of the quota can be the one the vehicle declines. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProblemDetail"];
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Unexpected internal application error. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProblemDetail"];
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Service temporarily unavailable (e.g. the API key could not be validated). Retry after the period indicated by the `Retry-After` header. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProblemDetail"];
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Operation timeout. */
            504: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProblemDetail"];
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
        };
    };
    startActiveVentilation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Unique VIN of the vehicle. */
                vin: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request to start active ventilation was performed. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Bad request (e.g. an unknown `include` value or a malformed request body). When a request parameter is rejected, the problem carries the extension members `parameter`, `rejectedValue` and `allowedValues` identifying what to fix. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Unauthorized. If the API key has expired the problem type is https://public.api.connect.skoda-auto.cz/problems/api-key-expired. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Forbidden. The `type` member tells the two causes apart:   * https://public.api.connect.skoda-auto.cz/problems/api-key-not-authorized - the API key does not cover the vehicle in the request path.   * https://public.api.connect.skoda-auto.cz/problems/operation-not-authorized - the key covers the vehicle, but the vehicle refused the operation for the user it belongs to. A user lacking the rights for an operation is normally answered with `422` before the operation is sent, so this is the rare case where the rights changed, or could not be checked, in between. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description No vehicle found for the given VIN. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description The vehicle cannot execute the operation. The problem type is https://public.api.connect.skoda-auto.cz/problems/operation-not-supported when the vehicle lacks the capability the operation needs (e.g. a vehicle without a high-voltage battery cannot charge), or https://public.api.connect.skoda-auto.cz/problems/operation-disabled when it has the capability but the capability is currently disabled (e.g. revoked consent, expired license, workshop mode). Retrying does not help in either case. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Too many requests; retry after the period indicated by the `Retry-After` header. The `type` member tells the two possible causes apart:   * https://public.api.connect.skoda-auto.cz/problems/rate-limit-exceeded - the rate limit for the API key has been exceeded.   * https://public.api.connect.skoda-auto.cz/problems/vehicle-not-accepting-requests - the vehicle itself declined the operation, for example to limit how often it executes requests or because its battery level is too low.  The `RateLimit-*` headers describe the quota on every response, so they do not tell the two apart - the request that uses up the last of the quota can be the one the vehicle declines. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Unexpected internal application error. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Service temporarily unavailable (e.g. the API key could not be validated). Retry after the period indicated by the `Retry-After` header. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Operation timeout. */
            504: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
        };
    };
    stopActiveVentilation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Unique VIN of the vehicle. */
                vin: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request to stop active ventilation was performed. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Bad request (e.g. an unknown `include` value or a malformed request body). When a request parameter is rejected, the problem carries the extension members `parameter`, `rejectedValue` and `allowedValues` identifying what to fix. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Unauthorized. If the API key has expired the problem type is https://public.api.connect.skoda-auto.cz/problems/api-key-expired. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Forbidden. The `type` member tells the two causes apart:   * https://public.api.connect.skoda-auto.cz/problems/api-key-not-authorized - the API key does not cover the vehicle in the request path.   * https://public.api.connect.skoda-auto.cz/problems/operation-not-authorized - the key covers the vehicle, but the vehicle refused the operation for the user it belongs to. A user lacking the rights for an operation is normally answered with `422` before the operation is sent, so this is the rare case where the rights changed, or could not be checked, in between. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description No vehicle found for the given VIN. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description The vehicle cannot execute the operation. The problem type is https://public.api.connect.skoda-auto.cz/problems/operation-not-supported when the vehicle lacks the capability the operation needs (e.g. a vehicle without a high-voltage battery cannot charge), or https://public.api.connect.skoda-auto.cz/problems/operation-disabled when it has the capability but the capability is currently disabled (e.g. revoked consent, expired license, workshop mode). Retrying does not help in either case. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Too many requests; retry after the period indicated by the `Retry-After` header. The `type` member tells the two possible causes apart:   * https://public.api.connect.skoda-auto.cz/problems/rate-limit-exceeded - the rate limit for the API key has been exceeded.   * https://public.api.connect.skoda-auto.cz/problems/vehicle-not-accepting-requests - the vehicle itself declined the operation, for example to limit how often it executes requests or because its battery level is too low.  The `RateLimit-*` headers describe the quota on every response, so they do not tell the two apart - the request that uses up the last of the quota can be the one the vehicle declines. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Unexpected internal application error. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Service temporarily unavailable (e.g. the API key could not be validated). Retry after the period indicated by the `Retry-After` header. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Operation timeout. */
            504: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
        };
    };
    startAirConditioning: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Unique VIN of the vehicle. */
                vin: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["StartAirConditioningConfiguration"];
            };
        };
        responses: {
            /** @description Request to start air conditioning was performed. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Bad request (e.g. an unknown `include` value or a malformed request body). When a request parameter is rejected, the problem carries the extension members `parameter`, `rejectedValue` and `allowedValues` identifying what to fix. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Unauthorized. If the API key has expired the problem type is https://public.api.connect.skoda-auto.cz/problems/api-key-expired. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Forbidden. The `type` member tells the two causes apart:   * https://public.api.connect.skoda-auto.cz/problems/api-key-not-authorized - the API key does not cover the vehicle in the request path.   * https://public.api.connect.skoda-auto.cz/problems/operation-not-authorized - the key covers the vehicle, but the vehicle refused the operation for the user it belongs to. A user lacking the rights for an operation is normally answered with `422` before the operation is sent, so this is the rare case where the rights changed, or could not be checked, in between. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description No vehicle found for the given VIN. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description The vehicle cannot execute the operation. The problem type is https://public.api.connect.skoda-auto.cz/problems/operation-not-supported when the vehicle lacks the capability the operation needs (e.g. a vehicle without a high-voltage battery cannot charge), or https://public.api.connect.skoda-auto.cz/problems/operation-disabled when it has the capability but the capability is currently disabled (e.g. revoked consent, expired license, workshop mode). Retrying does not help in either case. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Too many requests; retry after the period indicated by the `Retry-After` header. The `type` member tells the two possible causes apart:   * https://public.api.connect.skoda-auto.cz/problems/rate-limit-exceeded - the rate limit for the API key has been exceeded.   * https://public.api.connect.skoda-auto.cz/problems/vehicle-not-accepting-requests - the vehicle itself declined the operation, for example to limit how often it executes requests or because its battery level is too low.  The `RateLimit-*` headers describe the quota on every response, so they do not tell the two apart - the request that uses up the last of the quota can be the one the vehicle declines. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Unexpected internal application error. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Service temporarily unavailable (e.g. the API key could not be validated). Retry after the period indicated by the `Retry-After` header. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Operation timeout. */
            504: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
        };
    };
    stopAirConditioning: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Unique VIN of the vehicle. */
                vin: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request to stop air conditioning was performed. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Bad request (e.g. an unknown `include` value or a malformed request body). When a request parameter is rejected, the problem carries the extension members `parameter`, `rejectedValue` and `allowedValues` identifying what to fix. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Unauthorized. If the API key has expired the problem type is https://public.api.connect.skoda-auto.cz/problems/api-key-expired. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Forbidden. The `type` member tells the two causes apart:   * https://public.api.connect.skoda-auto.cz/problems/api-key-not-authorized - the API key does not cover the vehicle in the request path.   * https://public.api.connect.skoda-auto.cz/problems/operation-not-authorized - the key covers the vehicle, but the vehicle refused the operation for the user it belongs to. A user lacking the rights for an operation is normally answered with `422` before the operation is sent, so this is the rare case where the rights changed, or could not be checked, in between. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description No vehicle found for the given VIN. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description The vehicle cannot execute the operation. The problem type is https://public.api.connect.skoda-auto.cz/problems/operation-not-supported when the vehicle lacks the capability the operation needs (e.g. a vehicle without a high-voltage battery cannot charge), or https://public.api.connect.skoda-auto.cz/problems/operation-disabled when it has the capability but the capability is currently disabled (e.g. revoked consent, expired license, workshop mode). Retrying does not help in either case. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Too many requests; retry after the period indicated by the `Retry-After` header. The `type` member tells the two possible causes apart:   * https://public.api.connect.skoda-auto.cz/problems/rate-limit-exceeded - the rate limit for the API key has been exceeded.   * https://public.api.connect.skoda-auto.cz/problems/vehicle-not-accepting-requests - the vehicle itself declined the operation, for example to limit how often it executes requests or because its battery level is too low.  The `RateLimit-*` headers describe the quota on every response, so they do not tell the two apart - the request that uses up the last of the quota can be the one the vehicle declines. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Unexpected internal application error. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Service temporarily unavailable (e.g. the API key could not be validated). Retry after the period indicated by the `Retry-After` header. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Operation timeout. */
            504: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
        };
    };
    startAuxiliaryHeating: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Unique VIN of the vehicle. */
                vin: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["StartAuxiliaryHeatingConfiguration"];
            };
        };
        responses: {
            /** @description Request to start auxiliary heating was performed. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Bad request (e.g. an unknown `include` value or a malformed request body). When a request parameter is rejected, the problem carries the extension members `parameter`, `rejectedValue` and `allowedValues` identifying what to fix. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Unauthorized. If the API key has expired the problem type is https://public.api.connect.skoda-auto.cz/problems/api-key-expired. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Forbidden. The `type` member tells the two causes apart:   * https://public.api.connect.skoda-auto.cz/problems/api-key-not-authorized - the API key does not cover the vehicle in the request path.   * https://public.api.connect.skoda-auto.cz/problems/operation-not-authorized - the key covers the vehicle, but the vehicle refused the operation for the user it belongs to. A user lacking the rights for an operation is normally answered with `422` before the operation is sent, so this is the rare case where the rights changed, or could not be checked, in between. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description No vehicle found for the given VIN. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description The vehicle cannot execute the operation. The problem type is https://public.api.connect.skoda-auto.cz/problems/operation-not-supported when the vehicle lacks the capability the operation needs (e.g. a vehicle without a high-voltage battery cannot charge), or https://public.api.connect.skoda-auto.cz/problems/operation-disabled when it has the capability but the capability is currently disabled (e.g. revoked consent, expired license, workshop mode). Retrying does not help in either case. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Too many requests; retry after the period indicated by the `Retry-After` header. The `type` member tells the two possible causes apart:   * https://public.api.connect.skoda-auto.cz/problems/rate-limit-exceeded - the rate limit for the API key has been exceeded.   * https://public.api.connect.skoda-auto.cz/problems/vehicle-not-accepting-requests - the vehicle itself declined the operation, for example to limit how often it executes requests or because its battery level is too low.  The `RateLimit-*` headers describe the quota on every response, so they do not tell the two apart - the request that uses up the last of the quota can be the one the vehicle declines. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Unexpected internal application error. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Service temporarily unavailable (e.g. the API key could not be validated). Retry after the period indicated by the `Retry-After` header. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Operation timeout. */
            504: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
        };
    };
    stopAuxiliaryHeating: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Unique VIN of the vehicle. */
                vin: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request to stop auxiliary heating was performed. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Bad request (e.g. an unknown `include` value or a malformed request body). When a request parameter is rejected, the problem carries the extension members `parameter`, `rejectedValue` and `allowedValues` identifying what to fix. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Unauthorized. If the API key has expired the problem type is https://public.api.connect.skoda-auto.cz/problems/api-key-expired. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Forbidden. The `type` member tells the two causes apart:   * https://public.api.connect.skoda-auto.cz/problems/api-key-not-authorized - the API key does not cover the vehicle in the request path.   * https://public.api.connect.skoda-auto.cz/problems/operation-not-authorized - the key covers the vehicle, but the vehicle refused the operation for the user it belongs to. A user lacking the rights for an operation is normally answered with `422` before the operation is sent, so this is the rare case where the rights changed, or could not be checked, in between. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description No vehicle found for the given VIN. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description The vehicle cannot execute the operation. The problem type is https://public.api.connect.skoda-auto.cz/problems/operation-not-supported when the vehicle lacks the capability the operation needs (e.g. a vehicle without a high-voltage battery cannot charge), or https://public.api.connect.skoda-auto.cz/problems/operation-disabled when it has the capability but the capability is currently disabled (e.g. revoked consent, expired license, workshop mode). Retrying does not help in either case. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Too many requests; retry after the period indicated by the `Retry-After` header. The `type` member tells the two possible causes apart:   * https://public.api.connect.skoda-auto.cz/problems/rate-limit-exceeded - the rate limit for the API key has been exceeded.   * https://public.api.connect.skoda-auto.cz/problems/vehicle-not-accepting-requests - the vehicle itself declined the operation, for example to limit how often it executes requests or because its battery level is too low.  The `RateLimit-*` headers describe the quota on every response, so they do not tell the two apart - the request that uses up the last of the quota can be the one the vehicle declines. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Unexpected internal application error. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Service temporarily unavailable (e.g. the API key could not be validated). Retry after the period indicated by the `Retry-After` header. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Operation timeout. */
            504: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
        };
    };
    startCharging: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Unique VIN of the vehicle. */
                vin: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request to start charging was performed. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Bad request (e.g. an unknown `include` value or a malformed request body). When a request parameter is rejected, the problem carries the extension members `parameter`, `rejectedValue` and `allowedValues` identifying what to fix. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Unauthorized. If the API key has expired the problem type is https://public.api.connect.skoda-auto.cz/problems/api-key-expired. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Forbidden. The `type` member tells the two causes apart:   * https://public.api.connect.skoda-auto.cz/problems/api-key-not-authorized - the API key does not cover the vehicle in the request path.   * https://public.api.connect.skoda-auto.cz/problems/operation-not-authorized - the key covers the vehicle, but the vehicle refused the operation for the user it belongs to. A user lacking the rights for an operation is normally answered with `422` before the operation is sent, so this is the rare case where the rights changed, or could not be checked, in between. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description No vehicle found for the given VIN. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description The vehicle cannot execute the operation. The problem type is https://public.api.connect.skoda-auto.cz/problems/operation-not-supported when the vehicle lacks the capability the operation needs (e.g. a vehicle without a high-voltage battery cannot charge), or https://public.api.connect.skoda-auto.cz/problems/operation-disabled when it has the capability but the capability is currently disabled (e.g. revoked consent, expired license, workshop mode). Retrying does not help in either case. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Too many requests; retry after the period indicated by the `Retry-After` header. The `type` member tells the two possible causes apart:   * https://public.api.connect.skoda-auto.cz/problems/rate-limit-exceeded - the rate limit for the API key has been exceeded.   * https://public.api.connect.skoda-auto.cz/problems/vehicle-not-accepting-requests - the vehicle itself declined the operation, for example to limit how often it executes requests or because its battery level is too low.  The `RateLimit-*` headers describe the quota on every response, so they do not tell the two apart - the request that uses up the last of the quota can be the one the vehicle declines. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Unexpected internal application error. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Service temporarily unavailable (e.g. the API key could not be validated). Retry after the period indicated by the `Retry-After` header. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Operation timeout. */
            504: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
        };
    };
    stopCharging: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Unique VIN of the vehicle. */
                vin: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request to stop charging was performed. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Bad request (e.g. an unknown `include` value or a malformed request body). When a request parameter is rejected, the problem carries the extension members `parameter`, `rejectedValue` and `allowedValues` identifying what to fix. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Unauthorized. If the API key has expired the problem type is https://public.api.connect.skoda-auto.cz/problems/api-key-expired. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Forbidden. The `type` member tells the two causes apart:   * https://public.api.connect.skoda-auto.cz/problems/api-key-not-authorized - the API key does not cover the vehicle in the request path.   * https://public.api.connect.skoda-auto.cz/problems/operation-not-authorized - the key covers the vehicle, but the vehicle refused the operation for the user it belongs to. A user lacking the rights for an operation is normally answered with `422` before the operation is sent, so this is the rare case where the rights changed, or could not be checked, in between. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description No vehicle found for the given VIN. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description The vehicle cannot execute the operation. The problem type is https://public.api.connect.skoda-auto.cz/problems/operation-not-supported when the vehicle lacks the capability the operation needs (e.g. a vehicle without a high-voltage battery cannot charge), or https://public.api.connect.skoda-auto.cz/problems/operation-disabled when it has the capability but the capability is currently disabled (e.g. revoked consent, expired license, workshop mode). Retrying does not help in either case. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Too many requests; retry after the period indicated by the `Retry-After` header. The `type` member tells the two possible causes apart:   * https://public.api.connect.skoda-auto.cz/problems/rate-limit-exceeded - the rate limit for the API key has been exceeded.   * https://public.api.connect.skoda-auto.cz/problems/vehicle-not-accepting-requests - the vehicle itself declined the operation, for example to limit how often it executes requests or because its battery level is too low.  The `RateLimit-*` headers describe the quota on every response, so they do not tell the two apart - the request that uses up the last of the quota can be the one the vehicle declines. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Unexpected internal application error. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Service temporarily unavailable (e.g. the API key could not be validated). Retry after the period indicated by the `Retry-After` header. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
            /** @description Operation timeout. */
            504: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetail"];
                };
            };
        };
    };
}
