declare module "*.css";
declare module "*.svg?url" {
  const url: string;
  export default url;
}
declare module "*.svg?raw" {
  const text: string;
  export default text;
}
