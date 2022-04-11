"use strict";

/*
 * Created with @iobroker/create-adapter v1.24.1
 */

// The adapter-core module gives you access to the core ioBroker functions
const utils = require("@iobroker/adapter-core");

// Needed modules
const cloudPlatform = require("./lib/melcloudPlatform");
const commonDefines = require("./lib/commonDefines");

let gthis = null; // global to 'this' of Melcloud main instance
let CloudPlatform = null;
const stateValueCache = {}; // used to store all adapter state values to check for unchanged values

class Melcloud extends utils.Adapter {
	/**
	 * @param {Partial<ioBroker.AdapterOptions>} [options={}]
	 */
	constructor(options) {
		// @ts-ignore
		super({
			...options,
			name: "melcloud",
		});
		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		this.on("unload", this.onUnload.bind(this));
		gthis = this;
		this.deviceObjects = []; // array of all device objects
		this.currentKnownDeviceIDs = []; // array of all current known device IDs
	}

	async decryptPassword() {
		const sysConfigObject = (await this.getForeignObjectAsync("system.config"));
		if (!this.supportsFeature || !this.supportsFeature("ADAPTER_AUTO_DECRYPT_NATIVE")) {
			if (sysConfigObject && sysConfigObject.native && sysConfigObject.native.secret) {
				this.config.melCloudPassword = commonDefines.decrypt(sysConfigObject.native.secret, this.config.melCloudPassword);
			} else {
				this.config.melCloudPassword = commonDefines.decrypt("Zgfr56gFe87jJOM", this.config.melCloudPassword);
			}
		}
	}

	async checkSettings() {
		this.log.debug("Checking adapter settings...");

		this.decryptPassword();

		if (this.config.melCloudEmail == null || this.config.melCloudEmail == "") {
			throw new Error("MELCloud username empty! Check settings.");
		}

		if (this.config.melCloudPassword == null || this.config.melCloudPassword == "") {
			throw new Error("MELCloud password empty! Check settings.");
		}

		// if pollingInterval <= 0 than set to 1
		if (this.config.pollingInterval <= 0) {
			this.config.pollingInterval = 1;
			this.log.warn("Polling interval was set to less than 1 minute. Now set to 1 minute.");
		}
	}

	async setAdapterConnectionState(isConnected) {
		await this.setStateChangedAsync(`${commonDefines.AdapterDatapointIDs.Info}.${commonDefines.AdapterStateIDs.Connection}`, isConnected, true);
		await this.setForeignState(`system.adapter.${this.namespace}.connected`, isConnected, true);
	}

	async saveKnownDeviceIDs() {
		this.log.debug("Getting current known devices...");
		const prefix = `${this.namespace}.${commonDefines.AdapterDatapointIDs.Devices}.`;
		const objects = await this.getAdapterObjectsAsync();

		for (const id of Object.keys(objects)) {
			if (!id.startsWith(prefix)) {
				continue;
			}

			const deviceIdTemp = id.replace(prefix, "");
			const deviceId = parseInt(deviceIdTemp.substring(0, deviceIdTemp.lastIndexOf(".")), 10);

			// Add each device only one time
			if (!isNaN(deviceId) && !this.currentKnownDeviceIDs.includes(deviceId)) {
				this.currentKnownDeviceIDs.push(deviceId);
				this.log.debug(`Found known device: ${deviceId}`);
			}
		}

		if (this.currentKnownDeviceIDs.length == 0) {
			this.log.debug("No known devices found.");
		}
	}

	async deleteMelDevice(id) {
		const prefix = `${this.namespace}.${commonDefines.AdapterDatapointIDs.Devices}.${id}`;
		const objects = await this.getAdapterObjectsAsync();

		for (const id of Object.keys(objects)) {
			if (id.startsWith(prefix)) {
				const objID = id.replace(`${this.namespace}.`, "");
				this.log.debug(`Deleting state '${objID}'`);
				await this.delObjectAsync(objID);
			}
		}
	}

	async initObjects() {
		this.log.debug("Initializing objects...");

		await this.setObjectNotExistsAsync(commonDefines.AdapterDatapointIDs.Info, {
			type: "channel",
			common: {
				name: "Adapter information"
			},
			native: {}
		});

		await this.setObjectNotExistsAsync(`${commonDefines.AdapterDatapointIDs.Info}.${commonDefines.AdapterStateIDs.Connection}`, {
			type: "state",
			common: {
				name: "Connection to cloud",
				type: "boolean",
				role: "indicator.connected",
				read: true,
				write: false,
				desc: "Indicates if connection to MELCloud was successful or not"
			},
			native: {}
		});
		this.setAdapterConnectionState(false);
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		this.initObjects()
			.then(() => this.checkSettings()
				.then(() => this.saveKnownDeviceIDs()
					.then(() => {
						this.connectToCloud();
						this.subscribeStates("devices.*.control.*"); // subscribe to states changes under "devices.X.control."
						this.subscribeStates("devices.*.reports.*"); // subscribe to states changes under "devices.X.reports."
					})
				)
			)
			.catch(err => this.log.error(err));
	}

	async connectToCloud() {
		gthis.log.info("Connecting initially to MELCloud and retrieving data...");

		// Connect to cloud and retrieve/update registered devices initially
		CloudPlatform = new cloudPlatform.MelCloudPlatform(gthis);
		CloudPlatform.GetContextKey(CloudPlatform.CreateAndSaveDevices, CloudPlatform.startPolling);
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			this.setAdapterConnectionState(false);
			this.deviceObjects.length = 0;
			if (CloudPlatform != null) CloudPlatform.stopPolling();

			this.log.info("onUnload(): Cleaned everything up...");
			callback();
			// eslint-disable-next-line no-unused-vars
		} catch (e) {
			callback();
		}
	}

	/**
	 * Is called if a subscribed state changes
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	onStateChange(id, state) {
		// The state was changed
		if (state) {
			if (stateValueCache[id] != undefined && stateValueCache[id] != null && stateValueCache[id] == state.val) {
				this.log.silly(`state ${id} unchanged: ${state.val} (ack = ${state.ack})`);
				return;
			}

			stateValueCache[id] = state.val;

			this.log.silly(`state ${id} changed: ${state.val} (ack = ${state.ack})`);

			// ack is true when state was updated by MELCloud --> in this case, we don't need to send it again
			if (state.ack) {
				this.log.silly("Updated data was retrieved from MELCloud. No need to process changed data.");
				return;
			}

			if (this.deviceObjects == [] || this.deviceObjects.length == 0) {
				this.log.error("No objects for MELCloud devices constructed yet. Try again in a few seconds...");
				return;
			}

			// Only states under "devices.XXX.control" and "devices.XXX.reports" are subscribed
			let deviceId = id.replace(`${this.namespace}.${commonDefines.AdapterDatapointIDs.Devices}.`, "");
			deviceId = deviceId.substring(0, deviceId.indexOf("."));

			// Get the device object that should be changed
			this.log.debug(`Trying to get device object with id ${deviceId}...`);
			const device = this.deviceObjects.find(obj => {
				return obj.id === parseInt(deviceId);
			});

			if (device == null) {
				let knownIds = "";
				this.deviceObjects.forEach(obj => knownIds += `${obj.id}, `);
				this.log.error(`Failed to get device object. Known object IDs: ${knownIds}`);
				this.log.error("This should not happen - report this to the developer!");
				return;
			}

			const controlOption = id.substring(id.lastIndexOf(".") + 1, id.length);
			this.log.debug(`Processing command '${controlOption}' with value '${state.val}' for device object with id ${device.id} (${device.name})...`);

			const type = device.deviceType;

			switch (type) {
				case commonDefines.DeviceTypes.AirToAir: this.processAtaDeviceCommand(controlOption, state, device); break;
				case commonDefines.DeviceTypes.AirToWater: this.processAtwDeviceCommand(controlOption, state, device); break;
				default: this.log.error(`Unsupported device type: '${type}' - Please report this to the developer!`); break;
			}
		}
		// The state was deleted
		else {
			this.log.silly(`state ${id} deleted`);

			if (stateValueCache[id]) {
				delete stateValueCache[id];
			}
		}
	}

	mapAtaDeviceOperationMode(value) {
		switch (value) {
			case (commonDefines.AtaDeviceOperationModes.HEAT.value):
				return commonDefines.AtaDeviceOperationModes.HEAT;
			case (commonDefines.AtaDeviceOperationModes.DRY.value):
				return commonDefines.AtaDeviceOperationModes.DRY;
			case (commonDefines.AtaDeviceOperationModes.COOL.value):
				return commonDefines.AtaDeviceOperationModes.COOL;
			case (commonDefines.AtaDeviceOperationModes.VENT.value):
				return commonDefines.AtaDeviceOperationModes.VENT;
			case (commonDefines.AtaDeviceOperationModes.AUTO.value):
				return commonDefines.AtaDeviceOperationModes.AUTO;
			default:
				this.log.error(`Unsupported ATA operation mode: '${value}' - Please report this to the developer!`);
				return commonDefines.AtaDeviceOperationModes.UNDEF;
		}
	}

	mapAtwDeviceZoneOperationMode(value) {
		switch (value) {
			case (commonDefines.AtwDeviceZoneOperationModes.HEATTHERMOSTAT.value):
				return commonDefines.AtwDeviceZoneOperationModes.HEATTHERMOSTAT;
			case (commonDefines.AtwDeviceZoneOperationModes.HEATFLOW.value):
				return commonDefines.AtwDeviceZoneOperationModes.HEATFLOW;
			case (commonDefines.AtwDeviceZoneOperationModes.CURVE.value):
				return commonDefines.AtwDeviceZoneOperationModes.CURVE;
			case (commonDefines.AtwDeviceZoneOperationModes.COOLTHERMOSTAT.value):
				return commonDefines.AtwDeviceZoneOperationModes.COOLTHERMOSTAT;
			case (commonDefines.AtwDeviceZoneOperationModes.COOLFLOW.value):
				return commonDefines.AtwDeviceZoneOperationModes.COOLFLOW;
			default:
				this.log.error(`Unsupported ATW zone operation mode: '${value}' - Please report this to the developer!`);
				return commonDefines.AtwDeviceZoneOperationModes.UNDEF;
		}
	}

	processAtaDeviceCommand(controlOption, state, device) {
		switch (controlOption) {
			case (commonDefines.AtaDeviceStateIDs.Power):
				if (state.val) {
					// switch on using current operation mode
					device.getDeviceInfo(device.setDevice, commonDefines.AtaDeviceOptions.PowerState, commonDefines.DevicePowerStates.ON);
				}
				else {
					// switch off
					device.getDeviceInfo(device.setDevice, commonDefines.AtaDeviceOptions.PowerState, commonDefines.DevicePowerStates.OFF);
				}
				break;
			case (commonDefines.AtaDeviceStateIDs.Mode):
				device.getDeviceInfo(device.setDevice, commonDefines.AtaDeviceOptions.TargetHeatingCoolingState, this.mapAtaDeviceOperationMode(state.val));
				break;
			case (commonDefines.AtaDeviceStateIDs.TargetTemp):
				device.getDeviceInfo(device.setDevice, commonDefines.AtaDeviceOptions.TargetTemperature, state.val);
				break;
			case (commonDefines.AtaDeviceStateIDs.FanSpeedManual):
				device.getDeviceInfo(device.setDevice, commonDefines.AtaDeviceOptions.FanSpeed, state.val);
				break;
			case (commonDefines.AtaDeviceStateIDs.VaneVerticalDirection):
				device.getDeviceInfo(device.setDevice, commonDefines.AtaDeviceOptions.VaneVerticalDirection, state.val);
				break;
			case (commonDefines.AtaDeviceStateIDs.VaneHorizontalDirection):
				device.getDeviceInfo(device.setDevice, commonDefines.AtaDeviceOptions.VaneHorizontalDirection, state.val);
				break;
			case (commonDefines.AtaDeviceStateIDs.GetPowerConsumptionReport):
				device.getPowerConsumptionReport();
				break;
			case (commonDefines.AtaDeviceStateIDs.ReportStartDate):
			case (commonDefines.AtaDeviceStateIDs.ReportEndDate):
				// ignore these as they're just necessary for report request and shouldn't trigger any actions themselves
				break;
			default:
				this.log.error(`Unsupported ATA control option: ${controlOption} - Please report this to the developer!`);
				break;
		}
	}

	processAtwDeviceCommand(controlOption, state, device) {
		switch (controlOption) {
			case (commonDefines.AtwDeviceStateIDs.Power):
				if (state.val) {
					// switch on using current operation mode
					device.getDeviceInfo(device.setDevice, commonDefines.AtwDeviceOptions.PowerState, commonDefines.DevicePowerStates.ON);
				}
				else {
					// switch off
					device.getDeviceInfo(device.setDevice, commonDefines.AtwDeviceOptions.PowerState, commonDefines.DevicePowerStates.OFF);
				}
				break;
			case (commonDefines.AtwDeviceStateIDs.ForcedHotWaterMode):
				device.getDeviceInfo(device.setDevice, commonDefines.AtwDeviceOptions.ForcedHotWaterMode, state.val);
				break;
			case (commonDefines.AtwDeviceStateIDs.OperationModeZone1):
				device.getDeviceInfo(device.setDevice, commonDefines.AtwDeviceOptions.OperationModeZone1, this.mapAtwDeviceZoneOperationMode(state.val));
				break;
			case (commonDefines.AtwDeviceStateIDs.OperationModeZone2):
				device.getDeviceInfo(device.setDevice, commonDefines.AtwDeviceOptions.OperationModeZone2, this.mapAtwDeviceZoneOperationMode(state.val));
				break;
			case (commonDefines.AtwDeviceStateIDs.SetTankWaterTemperature):
				device.getDeviceInfo(device.setDevice, commonDefines.AtwDeviceOptions.SetTankWaterTemperature, state.val);
				break;
			case (commonDefines.AtwDeviceStateIDs.SetTemperatureZone1):
				device.getDeviceInfo(device.setDevice, commonDefines.AtwDeviceOptions.SetTemperatureZone1, state.val);
				break;
			case (commonDefines.AtwDeviceStateIDs.SetTemperatureZone2):
				device.getDeviceInfo(device.setDevice, commonDefines.AtwDeviceOptions.SetTemperatureZone2, state.val);
				break;
			case (commonDefines.AtwDeviceStateIDs.SetHeatFlowTemperatureZone1):
				device.getDeviceInfo(device.setDevice, commonDefines.AtwDeviceOptions.SetHeatFlowTemperatureZone1, state.val);
				break;
			case (commonDefines.AtwDeviceStateIDs.SetHeatFlowTemperatureZone2):
				device.getDeviceInfo(device.setDevice, commonDefines.AtwDeviceOptions.SetHeatFlowTemperatureZone2, state.val);
				break;
			case (commonDefines.AtwDeviceStateIDs.SetCoolFlowTemperatureZone1):
				device.getDeviceInfo(device.setDevice, commonDefines.AtwDeviceOptions.SetCoolFlowTemperatureZone1, state.val);
				break;
			case (commonDefines.AtwDeviceStateIDs.SetCoolFlowTemperatureZone2):
				device.getDeviceInfo(device.setDevice, commonDefines.AtwDeviceOptions.SetCoolFlowTemperatureZone2, state.val);
				break;
			default:
				this.log.error(`Unsupported ATW control option: ${controlOption} - Please report this to the developer!`);
				break;
		}
	}
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<ioBroker.AdapterOptions>} [options={}]
	 */
	module.exports = (options) => new Melcloud(options);
} else {
	// otherwise start the instance directly
	new Melcloud();
}