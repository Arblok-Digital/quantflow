export class PaperOrderError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PaperOrderError";
    this.code = code;
  }
}
