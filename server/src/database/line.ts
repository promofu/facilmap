import { DataTypes, HasManyGetAssociationsMixin, Model, Op } from "sequelize";
import { BboxWithZoom, ID, Latitude, Line, LineCreate, ExtraInfo, LineUpdate, Longitude, PadId, Point, Route, TrackPoint } from "facilmap-types";
import Database from "./database.js";
import { BboxWithExcept, dataDefinition, DataModel, getLatType, getLonType, getPosType, getVirtualLatType, getVirtualLonType, makeBboxCondition, makeNotNullForeignKey, validateColour } from "./helpers.js";
import { groupBy, isEqual, mapValues, omit } from "lodash-es";
import { wrapAsync } from "../utils/streams.js";
import { calculateRouteForLine } from "../routing/routing.js";

export type LineWithTrackPoints = Line & {
	trackPoints: TrackPoint[];
}

function createLineModel() {
	return class LineModel extends Model {
		declare id: ID;
		declare padId: PadId;
		declare routePoints: string;
		declare mode: string;
		declare colour: string;
		declare width: number;
		declare name: string | null;
		declare distance: number | null;
		declare time: number | null;
		declare ascent: number | null;
		declare descent: number | null;
		declare top: Latitude;
		declare bottom: Latitude;
		declare left: Longitude;
		declare right: Longitude;
		declare extraInfo: string | null;

		declare getLinePoints: HasManyGetAssociationsMixin<LinePointModel>;
		declare toJSON: () => Line;
	}
}

function createLinePointModel() {
	return class LinePointModel extends Model {
		declare id: ID;
		declare lineId: ID;
		declare lat: Latitude;
		declare lon: Longitude;
		declare zoom: number;
		declare idx: number;
		declare ele: number | null;
		declare toJSON: () => TrackPoint;
	};
}

function createLineDataModel() {
	return class LineData extends DataModel {};
}

export type LineModel = InstanceType<ReturnType<typeof createLineModel>>;
export type LinePointModel = InstanceType<ReturnType<typeof createLinePointModel>>;

export default class DatabaseLines {

	LineModel = createLineModel();
	LinePointModel = createLinePointModel();
	LineDataModel = createLineDataModel();

	_db: Database;

	constructor(database: Database) {
		this._db = database;

		this.LineModel.init({
			routePoints : {
				type: DataTypes.TEXT,
				allowNull: false,
				get: function(this: LineModel) {
					const routePoints = this.getDataValue("routePoints");
					return routePoints != null ? JSON.parse(routePoints) : routePoints;
				},
				set: function(this: LineModel, v: Point[]) {
					for(let i=0; i<v.length; i++) {
						v[i].lat = Number(v[i].lat.toFixed(6));
						v[i].lon = Number(v[i].lon.toFixed(6));
					}
					this.setDataValue("routePoints", JSON.stringify(v));
				},
				validate: {
					minTwo: function(val: string) {
						const routePoints = JSON.parse(val);
						if(!Array.isArray(routePoints))
							throw new Error("routePoints is not an array");
						if(routePoints.length < 2)
							throw new Error("A line cannot have less than two route points.");
					}
				}
			},
			mode : { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
			colour : { type: DataTypes.STRING(6), allowNull: false, defaultValue: "0000ff", validate: validateColour },
			width : { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 4, validate: { min: 1 } },
			name : { type: DataTypes.TEXT, allowNull: true, get: function(this: LineModel) { return this.getDataValue("name") || "Untitled line"; } },
			distance : { type: DataTypes.FLOAT(24, 2).UNSIGNED, allowNull: true },
			time : { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
			ascent : { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
			descent : { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
			top: getLatType(),
			bottom: getLatType(),
			left: getLonType(),
			right: getLonType(),
			extraInfo: {
				type: DataTypes.TEXT,
				allowNull: true,
				get: function(this: LineModel) {
					const extraInfo = this.getDataValue("extraInfo");
					return extraInfo != null ? JSON.parse(extraInfo) : extraInfo;
				},
				set: function(this: LineModel, v: ExtraInfo) {
					this.setDataValue("extraInfo", JSON.stringify(v));
				}
			}
		}, {
			sequelize: this._db._conn,
			modelName: "Line"
		});

		this.LinePointModel.init({
			lat: getVirtualLatType(),
			lon: getVirtualLonType(),
			pos: getPosType(),
			zoom: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, validate: { min: 1, max: 20 } },
			idx: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
			ele: { type: DataTypes.INTEGER, allowNull: true }
		}, {
			sequelize: this._db._conn,
			indexes: [
				{ fields: [ "lineId", "zoom" ] }
				// pos index is created in migration
			],
			modelName: "LinePoint"
		});

		this.LineDataModel.init(dataDefinition, {
			sequelize: this._db._conn,
			modelName: "LineData"
		});
	}

	afterInit(): void {
		this.LineModel.belongsTo(this._db.pads.PadModel, makeNotNullForeignKey("pad", "padId"));
		this._db.pads.PadModel.hasMany(this.LineModel, { foreignKey: "padId" });

		// TODO: Cascade
		this.LineModel.belongsTo(this._db.types.TypeModel, makeNotNullForeignKey("type", "typeId", true));

		this.LinePointModel.belongsTo(this.LineModel, makeNotNullForeignKey("line", "lineId"));
		this.LineModel.hasMany(this.LinePointModel, { foreignKey: "lineId" });

		this.LineDataModel.belongsTo(this.LineModel, makeNotNullForeignKey("line", "lineId"));
		this.LineModel.hasMany(this.LineDataModel, { foreignKey: "lineId" });
	}

	getPadLines(padId: PadId, fields?: Array<keyof Line>): Highland.Stream<Line> {
		const cond = fields ? { attributes: fields } : { };
		return this._db.helpers._getPadObjects<Line>("Line", padId, cond);
	}

	getPadLinesByType(padId: PadId, typeId: ID): Highland.Stream<Line> {
		return this._db.helpers._getPadObjects<Line>("Line", padId, { where: { typeId: typeId } });
	}

	getPadLinesWithPoints(padId: PadId): Highland.Stream<LineWithTrackPoints> {
		return this.getPadLines(padId)
			.flatMap(wrapAsync(async (line): Promise<LineWithTrackPoints> => {
				const trackPoints = await this.getAllLinePoints(line.id);
				return { ...line, trackPoints };
			}));
	}

	async getLineTemplate(padId: PadId, data: { typeId: ID }): Promise<Line> {
		const lineTemplate = {
			...this.LineModel.build({ ...data, padId: padId }).toJSON(),
			data: { }
		} as Line;

		const type = await this._db.types.getType(padId, data.typeId);

		if(type.defaultColour)
			lineTemplate.colour = type.defaultColour;
		if(type.defaultWidth)
			lineTemplate.width = type.defaultWidth;
		if(type.defaultMode)
			lineTemplate.mode = type.defaultMode;

		await this._db.helpers._updateObjectStyles(lineTemplate);

		return lineTemplate;
	}

	getLine(padId: PadId, lineId: ID): Promise<Line> {
		return this._db.helpers._getPadObject<Line>("Line", padId, lineId);
	}

	async createLine(padId: PadId, data: LineCreate, trackPointsFromRoute?: Route): Promise<Line> {
		const type = await this._db.types.getType(padId, data.typeId);

		if(type.defaultColour && !data.colour)
			data.colour = type.defaultColour;
		if(type.defaultWidth && !data.width)
			data.width = type.defaultWidth;
		if(type.defaultMode && !data.mode)
			data.mode = type.defaultMode;

		const { trackPoints, ...routeInfo } = await calculateRouteForLine(data, trackPointsFromRoute);

		const dataCopy = { ...data, ...routeInfo };
		delete dataCopy.trackPoints; // They came if mode is track

		const createdLine = await this._db.helpers._createPadObject<Line>("Line", padId, dataCopy);
		await this._db.helpers._updateObjectStyles(createdLine);

		// We have to emit this before calling _setLinePoints so that this event is sent to the client first
		this._db.emit("line", padId, createdLine);

		await this._setLinePoints(padId, createdLine.id, trackPoints);

		return createdLine;
	}

	async updateLine(padId: PadId, lineId: ID, data: LineUpdate, doNotUpdateStyles?: boolean, trackPointsFromRoute?: Route): Promise<Line> {
		const originalLine = await this.getLine(padId, lineId);
		const update = {
			...data,
			routePoints: data.routePoints || originalLine.routePoints,
			mode: (data.mode ?? originalLine.mode) || ""
		};

		let routeInfo;
		if((update.mode == "track" && update.trackPoints) || !isEqual(update.routePoints, originalLine.routePoints) || update.mode != originalLine.mode)
			routeInfo = await calculateRouteForLine(update, trackPointsFromRoute);

		Object.assign(update, mapValues(routeInfo, (val) => val == null ? null : val)); // Use null instead of undefined
		delete update.trackPoints; // They came if mode is track

		const newLine = await this._db.helpers._updatePadObject<Line>("Line", padId, lineId, update, doNotUpdateStyles);

		if(!doNotUpdateStyles)
			await this._db.helpers._updateObjectStyles(newLine); // Modifies newLine

		this._db.emit("line", padId, newLine);

		if(routeInfo)
			await this._setLinePoints(padId, lineId, routeInfo.trackPoints);

		return newLine;
	}

	async _setLinePoints(padId: PadId, lineId: ID, trackPoints: Point[], _noEvent?: boolean): Promise<void> {
		// First get elevation, so that if that fails, we don't update anything
		await this.LinePointModel.destroy({ where: { lineId: lineId } });

		const create = [ ];
		for(let i=0; i<trackPoints.length; i++) {
			create.push({ ...trackPoints[i], lineId: lineId });
		}

		const points = await this._db.helpers._bulkCreateInBatches<TrackPoint>(this.LinePointModel, create);

		if(!_noEvent)
			this._db.emit("linePoints", padId, lineId, points.map((point) => omit(point, ["lineId", "pos"]) as TrackPoint));
	}

	async deleteLine(padId: PadId, lineId: ID): Promise<Line> {
		await this._setLinePoints(padId, lineId, [ ], true);
		const oldLine = await this._db.helpers._deletePadObject<Line>("Line", padId, lineId);
		this._db.emit("deleteLine", padId, { id: lineId });
		return oldLine;
	}

	getLinePointsForPad(padId: PadId, bboxWithZoom: BboxWithZoom & BboxWithExcept): Highland.Stream<{ id: ID; trackPoints: TrackPoint[] }> {
		return this._db.helpers._toStream(async () => await this.LineModel.findAll({ attributes: ["id"], where: { padId } }))
			.map((line) => line.id)
			.batch(50000)
			.flatMap(wrapAsync(async (lineIds) => {
				const linePoints = await this.LinePointModel.findAll({
					where: {
						[Op.and]: [
							{
								zoom: { [Op.lte]: bboxWithZoom.zoom },
								lineId: { [Op.in]: lineIds }
							},
							makeBboxCondition(bboxWithZoom)
						]
					},
					attributes: ["pos", "lat", "lon", "ele", "zoom", "idx", "lineId"]
				});

				return Object.entries(groupBy(linePoints, "lineId")).map(([key, val]) => ({
					id: Number(key),
					trackPoints: val.map((p) => omit(p.toJSON(), ["lineId", "pos"]))
				}));
			})).flatten();
	}

	async getAllLinePoints(lineId: ID): Promise<TrackPoint[]> {
		const points = await this.LineModel.build({ id: lineId }).getLinePoints({
			attributes: [ "pos", "lat", "lon", "ele", "zoom", "idx" ],
			order: [["idx", "ASC"]]
		});
		return points.map((point) => omit(point.toJSON(), ["pos"]) as TrackPoint);
	}

}