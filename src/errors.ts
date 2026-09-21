/**
 * Port of `exceptions.py`: miner error hierarchy.
 * `WebSocketClosed.received` mirrors the Python attribute.
 */

export class MinerException extends Error {
  constructor(message = "Unknown miner error") {
    super(message);
    this.name = "MinerException";
  }
}

export class ExitRequest extends MinerException {
  constructor() {
    super("Application was requested to exit");
    this.name = "ExitRequest";
  }
}

export class ReloadRequest extends MinerException {
  constructor() {
    super("Application was requested to reload entirely");
    this.name = "ReloadRequest";
  }
}

export class RequestException extends MinerException {
  constructor(message = "Unknown error during request") {
    super(message);
    this.name = "RequestException";
  }
}

export class RequestInvalid extends RequestException {
  constructor() {
    super("Request became invalid during its retry loop");
    this.name = "RequestInvalid";
  }
}

export class WebsocketClosed extends RequestException {
  readonly received: boolean;
  constructor(message = "Websocket has been closed", received = false) {
    super(message);
    this.name = "WebsocketClosed";
    this.received = received;
  }
}

export class LoginException extends RequestException {
  constructor(message = "Unknown error during login") {
    super(message);
    this.name = "LoginException";
  }
}

export class CaptchaRequired extends LoginException {
  constructor() {
    super("Captcha is required");
    this.name = "CaptchaRequired";
  }
}

export class GQLException extends RequestException {
  constructor(message: string) {
    super(message);
    this.name = "GQLException";
  }
}
