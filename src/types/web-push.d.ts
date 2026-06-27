declare module 'web-push' {
  export function setVapidDetails(
    subject: string,
    publicKey: string,
    privateKey: string,
  ): void;

  export function sendNotification(
    pushSubscription: any,
    payload: string,
    options?: any,
  ): Promise<any>;
}
