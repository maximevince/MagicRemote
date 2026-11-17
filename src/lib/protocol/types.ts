/** Data types of the Blackmagic SDI Camera Control Protocol (byte 6 of a packet). */
export type DataType = 'void' | 'int8' | 'int16' | 'int32' | 'int64' | 'string' | 'fixed16';

/** Operations (byte 7). The camera uses 2 ("status update") on every report it sends. */
export type Operation = 'assign' | 'offset' | 'status';

export const DATA_TYPE_ID: Readonly<Record<DataType, number>> = {
	void: 0,
	int8: 1,
	int16: 2,
	int32: 3,
	int64: 4,
	string: 5,
	fixed16: 128
};

export const OPERATION_ID: Readonly<Record<Operation, number>> = {
	assign: 0,
	offset: 1,
	status: 2
};

/** Bytes per element; strings are counted in bytes. Void carries no elements (but see codec). */
export const ELEMENT_SIZE: Readonly<Record<DataType, number>> = {
	void: 1,
	int8: 1,
	int16: 2,
	int32: 4,
	int64: 8,
	string: 1,
	fixed16: 2
};

/** `bigint` only for int64 (7.3 location); fixed16 values are real numbers (already divided by 2048). */
export type Values = number[] | bigint[] | string;

/** A packet to send. `dest` defaults to 255 (broadcast). */
export interface Packet {
	dest?: number;
	group: number;
	param: number;
	type: DataType;
	op: Operation;
	values: Values;
}

/** A packet as received. Unknown data types and operations are kept, never dropped. */
export interface DecodedPacket {
	dest: number;
	/** Byte 2. Always 0 ("change configuration") in practice. */
	command: number;
	/** Byte 3. Reserved; the timecode packet carries 0xFF here, so it is never validated. */
	source: number;
	group: number;
	param: number;
	/** Raw data type byte, e.g. 255 for the device-specific type the 6K G2 sends. */
	typeId: number;
	/** `null` when `typeId` is not a documented type. */
	type: DataType | null;
	opId: number;
	/** `null` for reserved or device-specific operations. */
	op: Operation | null;
	/** Decoded elements; `null` when the type is unknown (see `data`). */
	values: Values | null;
	/** Data bytes (cmdLen − 4), without padding. Always present, so unknown types survive. */
	data: Uint8Array;
	/** The whole packet, header included, without padding. */
	bytes: Uint8Array;
}

export interface Timecode {
	/** `null` when the BCD field holds a digit above 9. */
	hours: number | null;
	minutes: number | null;
	seconds: number | null;
	frames: number | null;
	dropFrame: boolean;
	/** The raw 32-bit BCD word. */
	bcd: number;
}
