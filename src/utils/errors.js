'use strict';

/**
 * Application error carrying an HTTP status code. Throwing these from services
 * lets the central error handler produce consistent JSON responses.
 */
class AppError extends Error {
  constructor(message, statusCode = 500, details) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    if (details) {
      this.details = details;
    }
    Error.captureStackTrace(this, this.constructor);
  }
}

const badRequest = (message, details) => new AppError(message, 400, details);
const notFound = (message) => new AppError(message, 404);
const forbidden = (message, details) => new AppError(message, 403, details);
const unauthorized = (message, details) => new AppError(message, 401, details);
const conflict = (message) => new AppError(message, 409);
const unprocessableEntity = (message, details) => new AppError(message, 422, details);
const tooManyRequests = (message, details) => new AppError(message, 429, details);
const serviceUnavailable = (message, details) => new AppError(message, 503, details);

module.exports = {
  AppError,
  badRequest,
  notFound,
  forbidden,
  unauthorized,
  conflict,
  unprocessableEntity,
  tooManyRequests,
  serviceUnavailable,
};
