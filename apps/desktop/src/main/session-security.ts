type PermissionRequestHandler = (
  webContents: unknown,
  permission: string,
  callback: (allowed: boolean) => void,
  details: unknown,
) => void;

type PermissionCheckHandler = (
  webContents: unknown,
  permission: string,
  requestingOrigin: string,
  details: unknown,
) => boolean;

export type SessionPermissionBoundary = {
  setPermissionRequestHandler(handler: PermissionRequestHandler): void;
  setPermissionCheckHandler(handler: PermissionCheckHandler): void;
};

export function configureDenyAllSessionPermissions(
  session: SessionPermissionBoundary,
): void {
  session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  session.setPermissionCheckHandler(() => false);
}
