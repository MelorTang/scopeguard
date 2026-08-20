const MINIMAL_CHILD_ENVIRONMENT_NAMES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
  "USERPROFILE",
] as const;

export function isolatedChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  explicit: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    MINIMAL_CHILD_ENVIRONMENT_NAMES.flatMap((name) => {
      const value = source[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  for (const [name, value] of Object.entries(explicit)) {
    if (value === undefined) {
      throw new Error(`Explicit child environment value ${name} is undefined.`);
    }
    environment[name] = value;
  }
  return environment;
}
