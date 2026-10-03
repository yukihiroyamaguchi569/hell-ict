/*
 * Read by typescript-eslint only (tsconfig.eslint.json). Plain TypeScript cannot resolve a .vue
 * import, so without this the linter sees every SFC imported from a .ts file as an error type and
 * reports no-unsafe-* on it. vue-tsc (pnpm typecheck) never includes this file: it resolves each
 * .vue import to the component's real type, and an import of a missing .vue still fails there.
 */
declare module "*.vue" {
  import type { DefineComponent } from "vue";

  const component: DefineComponent;
  export default component;
}
