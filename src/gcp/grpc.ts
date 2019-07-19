export interface Status {
  code: number;
  message: string;
  details: { [Name: string]: string };
}
