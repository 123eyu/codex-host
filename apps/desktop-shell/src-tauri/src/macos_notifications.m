// Native event-driven macOS desktop notifications with zero wait threads and
// zero main-thread RunLoop polling.
//
// Packaged `.app` bundles use UNUserNotificationCenter (real system permission
// checks/prompts + foreground banner presentation + click callbacks), guarded
// by @try/@catch in case an unsigned or unindexed bundle throws
// NSInternalInconsistencyException.
// Unbundled debug binaries with an embedded Info.plist (or bundles where UN is
// unavailable) use event-driven NSUserNotificationCenter delegates instead.
// Unbundled binaries without any bundle identifier degrade safely to Unsupported.

#import <CoreServices/CoreServices.h>
#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#include <stdint.h>
#include <stdio.h>
#include <strings.h>

typedef void (*CHNotificationClickCallback)(const char *session_id);
typedef void (*CHPermissionCallback)(void *ctx, int32_t permission);
typedef void (*CHRequestPermissionCallback)(void *ctx, int32_t permission, const char *error);
typedef void (*CHShowCallback)(void *ctx, const char *error);

// Keep in sync with `notifications::macos_native` in Rust.
enum {
    CH_BACKEND_UNSUPPORTED = 0,
    CH_BACKEND_USER_NOTIFICATIONS = 1,
    CH_BACKEND_LEGACY_CENTER = 2,
};

enum {
    CH_PERM_GRANTED = 0,
    CH_PERM_DENIED = 1,
    CH_PERM_PROMPT = 2,
    CH_PERM_UNSUPPORTED = 3,
};

static CHNotificationClickCallback gClickCallback = NULL;
static dispatch_queue_t callbackLockQueue(void) {
    static dispatch_queue_t queue = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        queue = dispatch_queue_create("com.codexhost.shell.notifications.callback", DISPATCH_QUEUE_SERIAL);
    });
    return queue;
}

static void dispatchSessionClick(id rawSessionId) {
    NSString *sessionId = [rawSessionId isKindOfClass:[NSString class]] ? (NSString *)rawSessionId : nil;
    __block CHNotificationClickCallback callback = NULL;
    dispatch_sync(callbackLockQueue(), ^{
        callback = gClickCallback;
    });
    if (callback != NULL) {
        callback(sessionId.length > 0 ? sessionId.UTF8String : NULL);
    }
}

int32_t codexhost_macos_notifications_select_backend(
    const char *bundle_id,
    const char *bundle_path_ext,
    int has_legacy_center
) {
    if (bundle_id == NULL || bundle_id[0] == '\0') {
        return CH_BACKEND_UNSUPPORTED;
    }
    if (bundle_path_ext != NULL && strcasecmp(bundle_path_ext, "app") == 0) {
        if (@available(macOS 10.14, *)) {
            return CH_BACKEND_USER_NOTIFICATIONS;
        }
    }
    return has_legacy_center ? CH_BACKEND_LEGACY_CENTER : CH_BACKEND_UNSUPPORTED;
}

int32_t codexhost_macos_notifications_map_un_status(int64_t status) {
    if (@available(macOS 10.14, *)) {
        switch ((UNAuthorizationStatus)status) {
            case UNAuthorizationStatusAuthorized:
            case UNAuthorizationStatusProvisional:
                return CH_PERM_GRANTED;
            case UNAuthorizationStatusDenied:
                return CH_PERM_DENIED;
            case UNAuthorizationStatusNotDetermined:
                return CH_PERM_PROMPT;
            default:
                // UNAuthorizationStatusEphemeral (4) is iOS/App Clips only, treat as granted if seen.
                if (status == 4) {
                    return CH_PERM_GRANTED;
                }
                return CH_PERM_UNSUPPORTED;
        }
    }
    return CH_PERM_UNSUPPORTED;
}

API_AVAILABLE(macos(10.14))
int32_t codexhost_macos_notifications_is_not_allowed_error(NSError * _Nullable error) {
    if (error == nil) {
        return 0;
    }
    return ([error.domain isEqualToString:UNErrorDomain] &&
            error.code == UNErrorCodeNotificationsNotAllowed)
        ? 1
        : 0;
}

API_AVAILABLE(macos(10.14))
int32_t codexhost_macos_notifications_resolve_not_allowed_status(int64_t status) {
    return ((UNAuthorizationStatus)status == UNAuthorizationStatusDenied)
        ? CH_PERM_DENIED
        : CH_PERM_UNSUPPORTED;
}

static BOOL isAppBundleMainProcess(void) {
    NSBundle *bundle = [NSBundle mainBundle];
    return bundle.bundleIdentifier.length > 0 &&
        [bundle.bundleURL.pathExtension.lowercaseString isEqualToString:@"app"];
}

API_AVAILABLE(macos(10.14))
static UNUserNotificationCenter *unCenterOrNil(void) {
    if (!isAppBundleMainProcess()) {
        return nil;
    }
    static UNUserNotificationCenter *cached = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        NSURL *bundleURL = [NSBundle mainBundle].bundleURL;
        if (bundleURL != nil) {
            // Ensure LaunchServices indexes bundles spawned directly from npm/libexec paths.
            (void)LSRegisterURL((__bridge CFURLRef)bundleURL, true);
        }
        @try {
            cached = [UNUserNotificationCenter currentNotificationCenter];
        } @catch (NSException *exception) {
            (void)exception;
            cached = nil;
        }
    });
    return cached;
}

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
static NSUserNotificationCenter *legacyCenterOrNil(void) {
    NSBundle *bundle = [NSBundle mainBundle];
    if (bundle.bundleIdentifier.length == 0) {
        return nil;
    }
    @try {
        return [NSUserNotificationCenter defaultUserNotificationCenter];
    } @catch (NSException *exception) {
        (void)exception;
        return nil;
    }
}
#pragma clang diagnostic pop

int32_t codexhost_macos_notifications_active_backend(void) {
    @autoreleasepool {
        NSBundle *bundle = [NSBundle mainBundle];
        if (bundle.bundleIdentifier.length == 0) {
            return CH_BACKEND_UNSUPPORTED;
        }
        if ([bundle.bundleURL.pathExtension.lowercaseString isEqualToString:@"app"]) {
            if (@available(macOS 10.14, *)) {
                if (unCenterOrNil() != nil) {
                    return CH_BACKEND_USER_NOTIFICATIONS;
                }
            }
        }
        return legacyCenterOrNil() != nil ? CH_BACKEND_LEGACY_CENTER : CH_BACKEND_UNSUPPORTED;
    }
}

API_AVAILABLE(macos(10.14))
@interface CHUNNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
+ (instancetype)sharedDelegate;
@end

API_AVAILABLE(macos(10.14))
@implementation CHUNNotificationDelegate

+ (instancetype)sharedDelegate {
    static CHUNNotificationDelegate *instance = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        instance = [[CHUNNotificationDelegate alloc] init];
    });
    return instance;
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions options))completionHandler {
    (void)center;
    (void)notification;
    if (@available(macOS 11.0, *)) {
        completionHandler(
            UNNotificationPresentationOptionBanner |
            UNNotificationPresentationOptionList |
            UNNotificationPresentationOptionSound
        );
    } else {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        completionHandler(UNNotificationPresentationOptionAlert | UNNotificationPresentationOptionSound);
#pragma clang diagnostic pop
    }
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
didReceiveNotificationResponse:(UNNotificationResponse *)response
         withCompletionHandler:(void (^)(void))completionHandler {
    (void)center;
    if (![response.actionIdentifier isEqualToString:UNNotificationDismissActionIdentifier]) {
        NSDictionary *userInfo = response.notification.request.content.userInfo;
        dispatchSessionClick(userInfo[@"sessionId"]);
    }
    completionHandler();
}

@end

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
@interface CHLegacyNotificationDelegate : NSObject <NSUserNotificationCenterDelegate>
+ (instancetype)sharedDelegate;
@end

@implementation CHLegacyNotificationDelegate

+ (instancetype)sharedDelegate {
    static CHLegacyNotificationDelegate *instance = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        instance = [[CHLegacyNotificationDelegate alloc] init];
    });
    return instance;
}

- (BOOL)userNotificationCenter:(NSUserNotificationCenter *)center
     shouldPresentNotification:(NSUserNotification *)notification {
    (void)center;
    (void)notification;
    return YES;
}

- (void)userNotificationCenter:(NSUserNotificationCenter *)center
       didActivateNotification:(NSUserNotification *)notification {
    NSDictionary *userInfo = notification.userInfo;
    dispatchSessionClick(userInfo[@"sessionId"]);
    [center removeDeliveredNotification:notification];
}

@end
#pragma clang diagnostic pop

static NSString *optionalUTF8String(const char *raw) {
    if (raw == NULL || raw[0] == '\0') {
        return nil;
    }
    return [NSString stringWithUTF8String:raw];
}

API_AVAILABLE(macos(10.14))
UNNotificationRequest *codexhost_macos_notifications_build_un_request(
    NSString * _Nullable title,
    NSString * _Nullable body,
    NSString * _Nullable tag,
    NSString * _Nullable sessionId
) {
    UNMutableNotificationContent *content = [[UNMutableNotificationContent alloc] init];
    content.title = title.length > 0 ? title : @"CodexHost";
    if (body.length > 0) {
        content.body = body;
    }
    content.sound = [UNNotificationSound defaultSound];
    if (tag.length > 0) {
        content.threadIdentifier = tag;
    }
    if (sessionId.length > 0) {
        content.userInfo = @{ @"sessionId": sessionId };
    }
    return [UNNotificationRequest requestWithIdentifier:NSUUID.UUID.UUIDString
                                                content:content
                                                trigger:nil];
}

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
NSUserNotification *codexhost_macos_notifications_build_legacy_notification(
    NSString * _Nullable title,
    NSString * _Nullable body,
    NSString * _Nullable tag,
    NSString * _Nullable sessionId
) {
    (void)tag;
    NSUserNotification *notification = [[NSUserNotification alloc] init];
    notification.title = title.length > 0 ? title : @"CodexHost";
    if (body.length > 0) {
        notification.informativeText = body;
    }
    notification.identifier = NSUUID.UUID.UUIDString;
    notification.soundName = NSUserNotificationDefaultSoundName;
    if (sessionId.length > 0) {
        notification.userInfo = @{ @"sessionId": sessionId };
    }
    return notification;
}

static BOOL deliverViaLegacyCenter(
    NSString * _Nullable title,
    NSString * _Nullable body,
    NSString * _Nullable tag,
    NSString * _Nullable sessionId
) {
    NSUserNotificationCenter *center = legacyCenterOrNil();
    if (center == nil) {
        return NO;
    }
    @try {
        NSUserNotification *notification =
            codexhost_macos_notifications_build_legacy_notification(title, body, tag, sessionId);
        [center deliverNotification:notification];
        return YES;
    } @catch (NSException *exception) {
        (void)exception;
        return NO;
    }
}
#pragma clang diagnostic pop

void codexhost_macos_notifications_install(CHNotificationClickCallback on_click) {
    @autoreleasepool {
        dispatch_sync(callbackLockQueue(), ^{
            gClickCallback = on_click;
        });

        int32_t backend = codexhost_macos_notifications_active_backend();
        if (backend == CH_BACKEND_USER_NOTIFICATIONS) {
            if (@available(macOS 10.14, *)) {
                UNUserNotificationCenter *center = unCenterOrNil();
                if (center != nil) {
                    @try {
                        center.delegate = [CHUNNotificationDelegate sharedDelegate];
                        return;
                    } @catch (NSException *exception) {
                        (void)exception;
                    }
                }
            }
        }
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        NSUserNotificationCenter *legacy = legacyCenterOrNil();
        if (legacy != nil) {
            @try {
                legacy.delegate = [CHLegacyNotificationDelegate sharedDelegate];
            } @catch (NSException *exception) {
                (void)exception;
            }
        }
#pragma clang diagnostic pop
    }
}

void codexhost_macos_notifications_get_permission(void *ctx, CHPermissionCallback callback) {
    @autoreleasepool {
        int32_t backend = codexhost_macos_notifications_active_backend();
        if (backend == CH_BACKEND_USER_NOTIFICATIONS) {
            if (@available(macOS 10.14, *)) {
                UNUserNotificationCenter *center = unCenterOrNil();
                if (center != nil) {
                    @try {
                        [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
                            @autoreleasepool {
                                int32_t mapped = codexhost_macos_notifications_map_un_status(
                                    (int64_t)settings.authorizationStatus
                                );
                                callback(ctx, mapped);
                            }
                        }];
                        return;
                    } @catch (NSException *exception) {
                        (void)exception;
                    }
                }
            }
        }
        callback(ctx, legacyCenterOrNil() != nil ? CH_PERM_GRANTED : CH_PERM_UNSUPPORTED);
    }
}

void codexhost_macos_notifications_request_permission(void *ctx, CHRequestPermissionCallback callback) {
    @autoreleasepool {
        int32_t backend = codexhost_macos_notifications_active_backend();
        if (backend == CH_BACKEND_USER_NOTIFICATIONS) {
            if (@available(macOS 10.14, *)) {
                UNUserNotificationCenter *center = unCenterOrNil();
                if (center != nil) {
                    @try {
                        UNAuthorizationOptions options =
                            UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge;
                        [center requestAuthorizationWithOptions:options completionHandler:^(BOOL granted, NSError * _Nullable error) {
                            @autoreleasepool {
                                if (error != nil && !granted) {
                                    if (codexhost_macos_notifications_is_not_allowed_error(error)) {
                                        fprintf(
                                            stderr,
                                            "CodexHost: macOS notifications not allowed (%s code %ld): %s\n",
                                            error.domain.UTF8String ?: "UNErrorDomain",
                                            (long)error.code,
                                            error.localizedDescription.UTF8String ?: "unknown error"
                                        );
                                        @try {
                                            [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
                                                @autoreleasepool {
                                                    int32_t resolved = codexhost_macos_notifications_resolve_not_allowed_status(
                                                        (int64_t)settings.authorizationStatus
                                                    );
                                                    callback(ctx, resolved, NULL);
                                                }
                                            }];
                                        } @catch (NSException *exception) {
                                            (void)exception;
                                            callback(ctx, CH_PERM_UNSUPPORTED, NULL);
                                        }
                                        return;
                                    }
                                    callback(ctx, CH_PERM_UNSUPPORTED, error.localizedDescription.UTF8String);
                                    return;
                                }
                                @try {
                                    [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
                                        @autoreleasepool {
                                            int32_t mapped = codexhost_macos_notifications_map_un_status(
                                                (int64_t)settings.authorizationStatus
                                            );
                                            callback(ctx, mapped, NULL);
                                        }
                                    }];
                                } @catch (NSException *exception) {
                                    (void)exception;
                                    callback(ctx, granted ? CH_PERM_GRANTED : CH_PERM_DENIED, NULL);
                                }
                            }
                        }];
                        return;
                    } @catch (NSException *exception) {
                        (void)exception;
                    }
                }
            }
        }
        callback(ctx, legacyCenterOrNil() != nil ? CH_PERM_GRANTED : CH_PERM_UNSUPPORTED, NULL);
    }
}

void codexhost_macos_notifications_show(
    const char *title_utf8,
    const char *body_utf8,
    const char *tag_utf8,
    const char *session_id_utf8,
    void *ctx,
    CHShowCallback callback
) {
    @autoreleasepool {
        int32_t backend = codexhost_macos_notifications_active_backend();
        NSString *title = optionalUTF8String(title_utf8);
        NSString *body = optionalUTF8String(body_utf8);
        NSString *tag = optionalUTF8String(tag_utf8);
        NSString *sessionId = optionalUTF8String(session_id_utf8);

        if (backend == CH_BACKEND_USER_NOTIFICATIONS) {
            if (@available(macOS 10.14, *)) {
                UNUserNotificationCenter *center = unCenterOrNil();
                if (center != nil) {
                    @try {
                        UNNotificationRequest *request =
                            codexhost_macos_notifications_build_un_request(title, body, tag, sessionId);
                        [center addNotificationRequest:request withCompletionHandler:^(NSError * _Nullable error) {
                            @autoreleasepool {
                                callback(ctx, error != nil ? error.localizedDescription.UTF8String : NULL);
                            }
                        }];
                        return;
                    } @catch (NSException *exception) {
                        (void)exception;
                    }
                }
            }
        }

        if (deliverViaLegacyCenter(title, body, tag, sessionId)) {
            callback(ctx, NULL);
            return;
        }

        callback(ctx, "Desktop notifications require an application bundle identifier on macOS");
    }
}
