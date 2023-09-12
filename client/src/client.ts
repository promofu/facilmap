import { io, Socket as SocketIO } from "socket.io-client";
import {
	Bbox,
	BboxWithZoom, EventHandler, EventName, FindOnMapQuery, FindPadsQuery, FindPadsResult, FindQuery, GetPadQuery, HistoryEntry, ID, Line, LineCreate,
	LineExportRequest, LineTemplateRequest, LineToRouteCreate, LineUpdate, MapEvents, Marker, MarkerCreate, MarkerUpdate, MultipleEvents, ObjectWithId,
	PadData, PadDataCreate, PadDataUpdate, PadId, PagedResults, RequestData, RequestName, ResponseData, Route, RouteClear, RouteCreate, RouteExportRequest,
	RouteInfo,
	RouteRequest,
	SearchResult,
	TrackPoint, Type, TypeCreate, TypeUpdate, View, ViewCreate, ViewUpdate, Writable
} from "facilmap-types";

export interface ClientEvents<DataType = Record<string, string>> extends MapEvents<DataType> {
	connect: [];
	disconnect: [string];
	connect_error: [Error];

	error: [Error];
	reconnect: [number];
	reconnect_attempt: [number];
	reconnect_error: [Error];
	reconnect_failed: [];

	serverError: [Error];

	loadStart: [];
	loadEnd: [];

	route: [RouteWithTrackPoints];
	clearRoute: [RouteClear];

	emit: { [eventName in RequestName]: [eventName, RequestData<eventName, DataType>] }[RequestName];
	emitResolve: { [eventName in RequestName]: [eventName, ResponseData<eventName, DataType>] }[RequestName];
	emitReject: [RequestName, Error];
}

const MANAGER_EVENTS: Array<EventName<ClientEvents>> = ['error', 'reconnect', 'reconnect_attempt', 'reconnect_error', 'reconnect_failed'];

export interface TrackPoints {
	[idx: number]: TrackPoint;
	length: number;
}

export interface LineWithTrackPoints<DataType = Record<string, string>> extends Line<DataType> {
	trackPoints: TrackPoints;
}

export interface RouteWithTrackPoints extends Omit<Route, "trackPoints"> {
	routeId?: string;
	trackPoints: TrackPoints;
}

export default class Client<DataType = Record<string, string>> {
	disconnected: boolean = true;
	server!: string;
	padId: string | undefined = undefined;
	bbox: BboxWithZoom | undefined = undefined;
	socket!: SocketIO;
	padData: PadData | undefined = undefined;
	readonly: boolean | undefined = undefined;
	writable: Writable | undefined = undefined;
	deleted: boolean = false;
	markers: Record<ID, Marker<DataType>> = { };
	lines: Record<ID, LineWithTrackPoints<DataType>> = { };
	views: Record<ID, View> = { };
	types: Record<ID, Type> = { };
	history: Record<ID, HistoryEntry> = { };
	route: RouteWithTrackPoints | undefined = undefined;
	routes: Record<string, RouteWithTrackPoints> = { };
	serverError: Error | undefined = undefined;
	loading: number = 0;

	_listeners: {
		[E in EventName<ClientEvents>]?: Array<EventHandler<ClientEvents, E>>
	} = { };
	_listeningToHistory: boolean = false;

	constructor(server: string, padId?: string) {
		this.server = server;
		this.padId = padId;
	}

	_set<O, K extends keyof O>(object: O, key: K, value: O[K]): void {
		object[key] = value;
	}

	_delete<O>(object: O, key: keyof O): void {
		delete object[key];
	}

	_decodeData(data: Record<string, string>): DataType {
		const result = Object.create(null);
		Object.assign(result, data);
		return result;
	}

	_encodeData(data: DataType): Record<string, string> {
		return data as any;
	}

	_fixRequestObject<T>(requestName: RequestName, obj: T): T {
		if (typeof obj != "object" || !(obj as any)?.data || !["addMarker", "editMarker", "addLine", "editLine"].includes(requestName))
			return obj;

		return {
			...obj,
			data: this._encodeData((obj as any).data)
		};
	}

	_fixResponseObject<T>(requestName: RequestName, obj: T): T {
		if (typeof obj != "object" || !(obj as any)?.data || !["getMarker", "addMarker", "editMarker", "deleteMarker", "getLineTemplate", "addLine", "editLine", "deleteLine"].includes(requestName))
			return obj;

		return {
			...obj,
			data: this._decodeData((obj as any).data)
		};
	}

	_fixEventObject<T extends any[]>(eventName: EventName<ClientEvents>, obj: T): T {
		if (typeof obj?.[0] != "object" || !obj?.[0]?.data || !["marker", "line"].includes(eventName))
			return obj;

		return [
			{
				...obj[0],
				data: this._decodeData((obj[0] as any).data)
			},
			...obj.slice(1)
		] as T;
	}

	async connect(): Promise<void> {
		const serverUrl = typeof location != "undefined" ? new URL(this.server, location.href) : new URL(this.server);
		const socket = io(serverUrl.origin, {
			forceNew: true,
			path: serverUrl.pathname.replace(/\/$/, "") + "/socket.io"
		});
		this._set(this, 'socket', socket);

		for(const i of Object.keys(this._handlers) as EventName<ClientEvents<DataType>>[]) {
			this.on(i, this._handlers[i] as EventHandler<ClientEvents<DataType>, typeof i>);
		}

		setTimeout(() => {
			this._simulateEvent("loadStart");
		}, 0);

		await new Promise<void>((resolve) => {
			this.once("connect", () => {
				this._simulateEvent("loadEnd");
				resolve();
			});
		});
	}

	on<E extends EventName<ClientEvents>>(eventName: E, fn: EventHandler<ClientEvents<DataType>, E>): void {
		if(!this._listeners[eventName]) {
			(MANAGER_EVENTS.includes(eventName) ? this.socket.io as any : this.socket)
				.on(eventName, (...[data]: ClientEvents<DataType>[E]) => { this._simulateEvent(eventName as any, data); });
		}

		this._set(this._listeners, eventName, [ ...(this._listeners[eventName] || [] as any), fn ]);
	}

	once<E extends EventName<ClientEvents>>(eventName: E, fn: EventHandler<ClientEvents<DataType>, E>): void {
		const handler = ((data: any) => {
			this.removeListener(eventName, handler);
			(fn as any)(data);
		}) as EventHandler<ClientEvents<DataType>, E>;
		this.on(eventName, handler);
	}

	removeListener<E extends EventName<ClientEvents>>(eventName: E, fn: EventHandler<ClientEvents<DataType>, E>): void {
		const listeners = this._listeners[eventName] as Array<EventHandler<ClientEvents<DataType>, E>> | undefined;
		if(listeners) {
			this._set(this._listeners, eventName, listeners.filter((listener) => (listener !== fn)) as any);
		}
	}

	async _emit<R extends RequestName>(eventName: R, ...[data]: RequestData<R, DataType> extends void ? [ ] : [ RequestData<R, DataType> ]): Promise<ResponseData<R, DataType>> {
		try {
			this._simulateEvent("loadStart");

			this._simulateEvent("emit", eventName as any, data as any);

			return await new Promise((resolve, reject) => {
				this.socket.emit(eventName, this._fixRequestObject(eventName, data), (err: Error, data: ResponseData<R, DataType>) => {
					if(err) {
						reject(err);
						this._simulateEvent("emitReject", eventName as any, err);
					} else {
						const fixedData = this._fixResponseObject(eventName, data);
						resolve(fixedData);
						this._simulateEvent("emitResolve", eventName as any, fixedData as any);
					}
				});
			});
		} finally {
			this._simulateEvent("loadEnd");
		}
	}

	_handlers: {
		[E in EventName<ClientEvents>]?: EventHandler<ClientEvents<DataType>, E>
	} = {
		padData: (data) => {
			this._set(this, 'padData', data);

			if(data.writable != null) {
				this._set(this, 'readonly', data.writable == 0);
				this._set(this, 'writable', data.writable);
			}

			const id = this.writable == 2 ? data.adminId : this.writable == 1 ? data.writeId : data.id;
			if(id != null)
				this._set(this, 'padId', id);
		},

		deletePad: () => {
			this._set(this, 'readonly', true);
			this._set(this, 'writable', 0);
			this._set(this, 'deleted', true);
		},

		marker: (data) => {
			this._set(this.markers, data.id, data);
		},

		deleteMarker: (data) => {
			this._delete(this.markers, data.id);
		},

		line: (data) => {
			this._set(this.lines, data.id, {
				...data,
				trackPoints: this.lines[data.id]?.trackPoints || { length: 0 }
			});
		},

		deleteLine: (data) => {
			this._delete(this.lines, data.id);
		},

		linePoints: (data) => {
			const line = this.lines[data.id];
			if(line == null)
				return console.error("Received line points for non-existing line "+data.id+".");

			this._set(line, 'trackPoints', this._mergeTrackPoints(data.reset ? {} : line.trackPoints, data.trackPoints));
		},

		routePoints: (data) => {
			if(!this.route) {
				console.error("Received route points for non-existing route.");
				return;
			}

			this._set(this.route, 'trackPoints', this._mergeTrackPoints(this.route.trackPoints, data));
		},

		routePointsWithId: (data) => {
			const route = this.routes[data.routeId];
			if(!route) {
				console.error("Received route points for non-existing route.");
				return;
			}

			this._set(route, 'trackPoints', this._mergeTrackPoints(route.trackPoints, data.trackPoints));
		},

		view: (data) => {
			this._set(this.views, data.id, data);
		},

		deleteView: (data) => {
			this._delete(this.views, data.id);
			if (this.padData) {
				if(this.padData.defaultViewId == data.id)
					this._set(this.padData, 'defaultViewId', null);
			}
		},

		type: (data) => {
			this._set(this.types, data.id, data);
		},

		deleteType: (data) => {
			this._delete(this.types, data.id);
		},

		disconnect: () => {
			this._set(this, 'disconnected', true);
			this._set(this, 'markers', { });
			this._set(this, 'lines', { });
			this._set(this, 'views', { });
			this._set(this, 'history', { });
		},

		connect: () => {
			this._set(this, 'disconnected', false); // Otherwise it gets set when padData arrives

			if(this.padId)
				this._setPadId(this.padId).catch(() => undefined);

			// TODO: Handle errors

			if(this.bbox)
				this.updateBbox(this.bbox).catch((err) => { console.error("Error updating bbox.", err); });

			if(this._listeningToHistory) // TODO: Execute after setPadId() returns
				this.listenToHistory().catch(function(err) { console.error("Error listening to history", err); });

			if(this.route)
				this.setRoute(this.route).catch((err) => { console.error("Error setting route.", err); });
			for (const route of Object.values(this.routes))
				this.setRoute(route).catch((err) => { console.error("Error setting route.", err); });
		},

		history: (data) => {
			this._set(this.history, data.id, data);
			// TODO: Limit to 50 entries
		},

		loadStart: () => {
			this._set(this, 'loading', this.loading + 1);
		},

		loadEnd: () => {
			this._set(this, 'loading', this.loading - 1);
		}
	};

	setPadId(padId: PadId): Promise<void> {
		if(this.padId != null)
			throw new Error("Pad ID already set.");

		return this._setPadId(padId);
	}

	async updateBbox(bbox: BboxWithZoom): Promise<void> {
		this._set(this, 'bbox', bbox);
		const obj = await this._emit("updateBbox", bbox);
		this._receiveMultiple(obj);
	}

	async getPad(data: GetPadQuery): Promise<FindPadsResult | undefined> {
		return await this._emit("getPad", data);
	}

	async findPads(data: FindPadsQuery): Promise<PagedResults<FindPadsResult>> {
		return await this._emit("findPads", data);
	}

	async createPad(data: PadDataCreate): Promise<void> {
		const obj = await this._emit("createPad", data);
		this._set(this, 'readonly', false);
		this._set(this, 'writable', 2);
		this._receiveMultiple(obj);
	}

	async editPad(data: PadDataUpdate): Promise<PadData> {
		return await this._emit("editPad", data);
	}

	async deletePad(): Promise<void> {
		return await this._emit("deletePad");
	}

	async listenToHistory(): Promise<void> {
		const obj = await this._emit("listenToHistory");
		this._set(this, '_listeningToHistory', true);
		this._receiveMultiple(obj);
	}

	async stopListeningToHistory(): Promise<void> {
		this._set(this, '_listeningToHistory', false);
		return await this._emit("stopListeningToHistory");
	}

	async revertHistoryEntry(data: ObjectWithId): Promise<void> {
		const obj = await this._emit("revertHistoryEntry", data);
		this._set(this, 'history', {});
		this._receiveMultiple(obj);
	}

	async getMarker(data: ObjectWithId): Promise<Marker<DataType>> {
		const marker = await this._emit("getMarker", data);
		this._set(this.markers, marker.id, marker);
		return marker;
	}

	async addMarker(data: MarkerCreate<DataType>): Promise<Marker<DataType>> {
		const marker = await this._emit("addMarker", data);
		// If the marker is out of view, we will not recieve it in an event. Add it here manually to make sure that we have it.
		this._set(this.markers, marker.id, marker);
		return marker;
	}

	async editMarker(data: ObjectWithId & MarkerUpdate<DataType>): Promise<Marker<DataType>> {
		return await this._emit("editMarker", data);
	}

	async deleteMarker(data: ObjectWithId): Promise<Marker<DataType>> {
		return await this._emit("deleteMarker", data);
	}

	async getLineTemplate(data: LineTemplateRequest): Promise<Line<DataType>> {
		return await this._emit("getLineTemplate", data);
	}

	async addLine(data: LineCreate<DataType>): Promise<Line<DataType>> {
		return await this._emit("addLine", data);
	}

	async editLine(data: ObjectWithId & LineUpdate<DataType>): Promise<Line<DataType>> {
		return await this._emit("editLine", data);
	}

	async deleteLine(data: ObjectWithId): Promise<Line<DataType>> {
		return await this._emit("deleteLine", data);
	}

	async exportLine(data: LineExportRequest): Promise<string> {
		return await this._emit("exportLine", data);
	}

	async find(data: FindQuery & { loadUrls?: false }): Promise<SearchResult[]>;
	async find(data: FindQuery & { loadUrls: true }): Promise<string | SearchResult[]>; // eslint-disable-line no-dupe-class-members
	async find(data: FindQuery): Promise<string | SearchResult[]> { // eslint-disable-line no-dupe-class-members
		return await this._emit("find", data);
	}

	async findOnMap(data: FindOnMapQuery): Promise<ResponseData<'findOnMap'>> {
		return await this._emit("findOnMap", data);
	}

	async getRoute(data: RouteRequest): Promise<RouteInfo> {
		return await this._emit("getRoute", data);
	}

	async setRoute(data: RouteCreate): Promise<RouteWithTrackPoints | undefined> {
		const route = await this._emit("setRoute", data);

		if(!route) // A newer submitted route has returned in the meantime
			return undefined;

		const result = {
			...route,
			trackPoints: this._mergeTrackPoints({}, route.trackPoints)
		};

		if (data.routeId)
			this._set(this.routes, data.routeId, result);
		else
			this._set(this, "route", result);

		this._simulateEvent("route", result);
		return result;
	}

	async clearRoute(data?: RouteClear): Promise<void> {
		if (data?.routeId) {
			this._delete(this.routes, data.routeId);
			this._simulateEvent("clearRoute", { routeId: data.routeId });
			return await this._emit("clearRoute", data);
		} else if (this.route) {
			this._set(this, 'route', undefined);
			this._simulateEvent("clearRoute", { routeId: undefined });
			return await this._emit("clearRoute", data);
		}
	}

	async lineToRoute(data: LineToRouteCreate): Promise<RouteWithTrackPoints | undefined> {
		const route = await this._emit("lineToRoute", data);

		if (!route) // A newer submitted route has returned in the meantime
			return undefined;

		const result = {
			...route,
			trackPoints: this._mergeTrackPoints({}, route.trackPoints)
		};

		if (data.routeId)
			this._set(this.routes, data.routeId, result);
		else
			this._set(this, "route", result);

		this._simulateEvent("route", result);
		return result;
	}

	async exportRoute(data: RouteExportRequest): Promise<string> {
		return await this._emit("exportRoute", data);
	}

	async addType(data: TypeCreate): Promise<Type> {
		return await this._emit("addType", data);
	}

	async editType(data: ObjectWithId & TypeUpdate): Promise<Type> {
		return await this._emit("editType", data);
	}

	async deleteType(data: ObjectWithId): Promise<Type> {
		return await this._emit("deleteType", data);
	}

	async addView(data: ViewCreate): Promise<View> {
		return await this._emit("addView", data);
	}

	async editView(data: ObjectWithId & ViewUpdate): Promise<View> {
		return await this._emit("editView", data);
	}

	async deleteView(data: ObjectWithId): Promise<View> {
		return await this._emit("deleteView", data);
	}

	async geoip(): Promise<Bbox | null> {
		return await this._emit("geoip");
	}

	disconnect(): void {
		this.socket.offAny();
		this.socket.disconnect();
	}

	async _setPadId(padId: string): Promise<void> {
		this._set(this, 'serverError', undefined);
		this._set(this, 'padId', padId);
		try {
			const obj = await this._emit("setPadId", padId);
			this._receiveMultiple(obj);
		} catch(err: any) {
			this._set(this, 'serverError', err);
			this._simulateEvent("serverError", err);
			throw err;
		}
	}

	_receiveMultiple(obj?: MultipleEvents<ClientEvents<DataType>>): void {
		if (obj) {
			for(const i of Object.keys(obj) as EventName<ClientEvents>[])
				(obj[i] as Array<ClientEvents<DataType>[typeof i][0]>).forEach((it) => { this._simulateEvent(i, it as any); });
		}
	}

	_simulateEvent<E extends EventName<ClientEvents>>(eventName: E, ...data: ClientEvents<DataType>[E]): void {
		const fixedData = this._fixEventObject(eventName, data);

		const listeners = this._listeners[eventName] as Array<EventHandler<ClientEvents<DataType>, E>> | undefined;
		if(listeners) {
			listeners.forEach(function(listener: EventHandler<ClientEvents<DataType>, E>) {
				listener(...fixedData);
			});
		}
	}

	_mergeTrackPoints(existingTrackPoints: Record<number, TrackPoint> | null, newTrackPoints: TrackPoint[]): TrackPoints {
		const ret = { ...(existingTrackPoints || { }) } as TrackPoints;

		for(let i=0; i<newTrackPoints.length; i++) {
			ret[newTrackPoints[i].idx] = newTrackPoints[i];
		}

		ret.length = 0;
		for(const i in ret) {
			if(i != "length")
				ret.length = Math.max(ret.length, parseInt(i) + 1);
		}

		return ret;
	}
}
