export class ErrorWithStatusCode extends Error {
  constructor(msg, options, statusCode) {
    super(msg, options);
    this.statusCode = statusCode;
  }
}