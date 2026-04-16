// Type definitions for movesense-driver

import { EventEmitter } from 'events';

export interface XYZ {
  x: number;
  y: number;
  z: number;
}

export interface XYZBatch {
  /** Sensor timestamp in milliseconds since boot */
  timestamp: number;
  samples: XYZ[];
}

export interface Imu6Sample {
  acc: XYZ;
  gyro: XYZ;
}

export interface Imu6Batch {
  timestamp: number;
  samples: Imu6Sample[];
}

export interface Imu9Sample {
  acc: XYZ;
  gyro: XYZ;
  magn: XYZ;
}

export interface Imu9Batch {
  timestamp: number;
  samples: Imu9Sample[];
}

export interface EcgBatch {
  timestamp: number;
  /** Raw int32 samples; multiply by 0.381 for microvolts */
  samples: number[];
}

export interface HrSample {
  /** Average heart rate in beats per minute */
  average: number;
  /** R-R intervals in milliseconds */
  rrIntervals: number[];
}

export interface TempSample {
  timestamp: number;
  kelvin: number;
  celsius: number;
}

export interface DeviceOptions {
  /** Reconnect automatically after an unexpected disconnect. Default true. */
  autoReconnect?: boolean;
  /** First retry delay in ms. Default 1000. */
  initialReconnectDelayMs?: number;
  /** Max retry delay in ms. Default 30000. */
  maxReconnectDelayMs?: number;
  /** Per-command timeout in ms. Default 5000. */
  commandTimeoutMs?: number;
}

export interface ReconnectingEvent {
  attempt: number;
  delayMs: number;
}

export type SensorParser<T> = (buf: Buffer) => T;

export interface Subscription {
  ref: number;
  path: string;
  event: string;
  parser: SensorParser<unknown>;
}

export interface GetResponse {
  status: number;
  payload: Buffer;
}

export class MovesenseDevice extends EventEmitter {
  readonly id: string;
  readonly localName: string | null;
  readonly serial: string | null;

  constructor(peripheral: unknown, opts?: DeviceOptions);

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  subscribeAcc(rate?: number): Promise<Subscription>;
  subscribeGyro(rate?: number): Promise<Subscription>;
  subscribeMagn(rate?: number): Promise<Subscription>;
  subscribeImu6(rate?: number): Promise<Subscription>;
  subscribeImu9(rate?: number): Promise<Subscription>;
  subscribeEcg(rate?: number): Promise<Subscription>;
  subscribeHr(): Promise<Subscription>;
  subscribeTemp(): Promise<Subscription>;
  subscribe<T>(path: string, parser: SensorParser<T>, event: string): Promise<Subscription>;
  unsubscribe(path: string): Promise<boolean>;

  get(path: string): Promise<GetResponse>;

  on(event: 'connect', listener: () => void): this;
  on(event: 'disconnect', listener: () => void): this;
  on(event: 'reconnecting', listener: (info: ReconnectingEvent) => void): this;
  on(event: 'reconnect', listener: () => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'acc',  listener: (data: XYZBatch) => void): this;
  on(event: 'gyro', listener: (data: XYZBatch) => void): this;
  on(event: 'magn', listener: (data: XYZBatch) => void): this;
  on(event: 'imu6', listener: (data: Imu6Batch) => void): this;
  on(event: 'imu9', listener: (data: Imu9Batch) => void): this;
  on(event: 'ecg',  listener: (data: EcgBatch) => void): this;
  on(event: 'hr',   listener: (data: HrSample) => void): this;
  on(event: 'rr',   listener: (rr: number[]) => void): this;
  on(event: 'temp', listener: (data: TempSample) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
}

export interface FindOneOptions {
  /** Match against the trailing token of the BLE local name (e.g. "210330000123") */
  serial?: string | number;
  timeoutMs?: number;
}

export class MovesenseScanner extends EventEmitter {
  constructor(opts?: DeviceOptions);
  start(): Promise<void>;
  stop(): Promise<void>;
  findOne(opts?: FindOneOptions): Promise<MovesenseDevice>;

  on(event: 'discover', listener: (device: MovesenseDevice) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
}

export const protocol: {
  SERVICE_UUID: string;
  WRITE_CHAR_UUID: string;
  NOTIFY_CHAR_UUID: string;
  CMD: { HELLO: number; SUBSCRIBE: number; UNSUBSCRIBE: number; GET: number; PUT: number; POST: number; DEL: number };
  RESP: { ONESHOT: number; DATA: number; DATA_CONT: number };
  buildSubscribe(ref: number, path: string): Buffer;
  buildUnsubscribe(ref: number): Buffer;
  buildGet(ref: number, path: string): Buffer;
};

export const parsers: {
  parseXYZ: SensorParser<XYZBatch>;
  parseImu6: SensorParser<Imu6Batch>;
  parseImu9: SensorParser<Imu9Batch>;
  parseEcg: SensorParser<EcgBatch>;
  parseHr: SensorParser<HrSample>;
  parseTemp: SensorParser<TempSample>;
};
