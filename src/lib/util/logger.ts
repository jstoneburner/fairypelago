import winston from 'winston'
import 'winston-daily-rotate-file'

const { combine, json, timestamp, errors, align, printf, colorize } = winston.format

// Winston's errors() format only handles top-level Error objects.
// This custom format also serializes Error instances nested inside metadata fields.
const serializeErrors = winston.format((info) => {
  for (const key of Object.keys(info)) {
    if (key === 'level' || key === 'message' || key === 'timestamp') continue
    const val = (info as Record<string, unknown>)[key]
    if (val instanceof Error) {
      // Start with non-enumerable Error properties (name, message, stack)
      const serialized: Record<string, unknown> = {
        name: val.name,
        message: val.message,
        stack: val.stack,
      }
      // Copy any additional enumerable own properties (e.g., code, errno, syscall on Node errors)
      for (const prop of Object.keys(val)) {
        serialized[prop] = (val as unknown as Record<string, unknown>)[prop]
      }
      (info as Record<string, unknown>)[key] = serialized
    }
  }
  return info
})()

const fileRotateTransport = new winston.transports.DailyRotateFile({
  filename: 'logs/all-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxFiles: '14d',
  format: combine(errors({ stack: true }), serializeErrors, timestamp(), json()),
})

const exceptionRotateTransport = new winston.transports.DailyRotateFile({
  filename: 'logs/exceptions-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxFiles: '14d',
})

const rejectionRotateTransport = new winston.transports.DailyRotateFile({
  filename: 'logs/rejections-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxFiles: '14d',
})

const consoleTransport = new winston.transports.Console({
  format: combine(
    align(),
    colorize({ all: true }),
    timestamp({ format: 'YYYY-MM-DD hh:mm:ss.SSS A' }),
    printf((info) => `[${info.timestamp}] ${info.level} | ${info.message}`),
  ),
})

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  transports: [
    fileRotateTransport,
    consoleTransport,
  ],
  exceptionHandlers: [exceptionRotateTransport],
  rejectionHandlers: [rejectionRotateTransport],
})

export const fileLogger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  transports: [fileRotateTransport],
})

export const consoleLogger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  transports: [consoleTransport],
})
