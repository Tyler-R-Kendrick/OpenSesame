/** Every refusal from the SLIP-0039 kernel. The message names the rule. */
export class Slip39Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Slip39Error";
  }
}
