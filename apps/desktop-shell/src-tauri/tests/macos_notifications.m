#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef void (*CHNotificationClickCallback)(const char *session_id);
typedef void (*CHPermissionCallback)(void *ctx, int32_t permission);
typedef void (*CHRequestPermissionCallback)(void *ctx, int32_t permission, const char *error);
typedef void (*CHShowCallback)(void *ctx, const char *error);

extern int32_t codexhost_macos_notifications_select_backend(
    const char *bundle_id,
    const char *bundle_path_ext,
    int has_legacy_center
);
extern int32_t codexhost_macos_notifications_map_un_status(int64_t status);
API_AVAILABLE(macos(10.14))
extern int32_t codexhost_macos_notifications_is_not_allowed_error(NSError * _Nullable error);
API_AVAILABLE(macos(10.14))
extern int32_t codexhost_macos_notifications_resolve_not_allowed_status(int64_t status);
extern int32_t codexhost_macos_notifications_active_backend(void);
extern void codexhost_macos_notifications_install(CHNotificationClickCallback on_click);
extern void codexhost_macos_notifications_get_permission(void *ctx, CHPermissionCallback callback);
extern void codexhost_macos_notifications_request_permission(
    void *ctx,
    CHRequestPermissionCallback callback
);
extern void codexhost_macos_notifications_show(
    const char *title_utf8,
    const char *body_utf8,
    const char *tag_utf8,
    const char *session_id_utf8,
    void *ctx,
    CHShowCallback callback
);

API_AVAILABLE(macos(10.14))
extern UNNotificationRequest *codexhost_macos_notifications_build_un_request(
    NSString * _Nullable title,
    NSString * _Nullable body,
    NSString * _Nullable tag,
    NSString * _Nullable sessionId
);

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
extern NSUserNotification *codexhost_macos_notifications_build_legacy_notification(
    NSString * _Nullable title,
    NSString * _Nullable body,
    NSString * _Nullable tag,
    NSString * _Nullable sessionId
);
#pragma clang diagnostic pop

API_AVAILABLE(macos(10.14))
@interface CHUNNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
+ (instancetype)sharedDelegate;
@end

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
@interface CHLegacyNotificationDelegate : NSObject <NSUserNotificationCenterDelegate>
+ (instancetype)sharedDelegate;
@end
#pragma clang diagnostic pop

// Lightweight test doubles for UNNotificationResponse -> UNNotification -> UNNotificationRequest -> UNNotificationContent.
@interface FakeUNContent : NSObject
@property(nonatomic, copy) NSDictionary *userInfo;
@end
@implementation FakeUNContent
@end

@interface FakeUNRequest : NSObject
@property(nonatomic, strong) FakeUNContent *content;
@end
@implementation FakeUNRequest
@end

@interface FakeUNNotification : NSObject
@property(nonatomic, strong) FakeUNRequest *request;
@end
@implementation FakeUNNotification
@end

@interface FakeUNResponse : NSObject
@property(nonatomic, copy) NSString *actionIdentifier;
@property(nonatomic, strong) FakeUNNotification *notification;
@end
@implementation FakeUNResponse
@end

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
@interface FakeLegacyCenter : NSObject
@property(nonatomic, strong) NSUserNotification *removed;
@end
@implementation FakeLegacyCenter
- (void)removeDeliveredNotification:(NSUserNotification *)notification {
    self.removed = notification;
}
@end
#pragma clang diagnostic pop

static int gClickCount = 0;
static NSString *gLastSessionId = nil;

static void recordClick(const char *session_id) {
    gClickCount += 1;
    gLastSessionId = session_id != NULL ? [NSString stringWithUTF8String:session_id] : nil;
}

static void onPermission(void *ctx, int32_t permission) {
    *(int32_t *)ctx = permission;
}

typedef struct {
    int32_t permission;
    int has_error;
} RequestPermResult;

static void onRequestPermission(void *ctx, int32_t permission, const char *error) {
    RequestPermResult *res = (RequestPermResult *)ctx;
    res->permission = permission;
    res->has_error = error != NULL ? 1 : 0;
}

static void onShow(void *ctx, const char *error) {
    *(int *)ctx = (error != NULL && error[0] != '\0') ? 1 : 0;
}

static void verifyUNDelegate(void) API_AVAILABLE(macos(10.14)) {
    NSCAssert(codexhost_macos_notifications_map_un_status(UNAuthorizationStatusAuthorized) == 0, @"authorized");
    NSCAssert(codexhost_macos_notifications_map_un_status(UNAuthorizationStatusProvisional) == 0, @"provisional");
    NSCAssert(codexhost_macos_notifications_map_un_status(UNAuthorizationStatusDenied) == 1, @"denied");
    NSCAssert(codexhost_macos_notifications_map_un_status(UNAuthorizationStatusNotDetermined) == 2, @"prompt");
    NSCAssert(codexhost_macos_notifications_map_un_status(99) == 3, @"unknown -> unsupported");

    NSError *notAllowedErr = [NSError errorWithDomain:UNErrorDomain
                                                 code:UNErrorCodeNotificationsNotAllowed
                                             userInfo:nil];
    NSError *otherUnErr = [NSError errorWithDomain:UNErrorDomain
                                              code:UNErrorCodeAttachmentInvalidURL
                                          userInfo:nil];
    NSError *otherDomainErr = [NSError errorWithDomain:NSCocoaErrorDomain
                                                  code:UNErrorCodeNotificationsNotAllowed
                                              userInfo:nil];
    NSCAssert(codexhost_macos_notifications_is_not_allowed_error(notAllowedErr) == 1, @"UNErrorDomain error 1");
    NSCAssert(codexhost_macos_notifications_is_not_allowed_error(otherUnErr) == 0, @"other UNError code");
    NSCAssert(codexhost_macos_notifications_is_not_allowed_error(otherDomainErr) == 0, @"non-UN error domain");
    NSCAssert(codexhost_macos_notifications_is_not_allowed_error(nil) == 0, @"nil error");
    NSCAssert(
        codexhost_macos_notifications_resolve_not_allowed_status(UNAuthorizationStatusDenied) == 1,
        @"not-allowed with Denied status maps to denied"
    );
    NSCAssert(
        codexhost_macos_notifications_resolve_not_allowed_status(UNAuthorizationStatusNotDetermined) == 3,
        @"not-allowed with NotDetermined status maps to unsupported"
    );
    NSCAssert(
        codexhost_macos_notifications_resolve_not_allowed_status(UNAuthorizationStatusAuthorized) == 3,
        @"not-allowed with Authorized status maps to unsupported"
    );

    CHUNNotificationDelegate *unDelegate = [CHUNNotificationDelegate sharedDelegate];
    id dummyCenter = [NSObject new];
    FakeUNContent *content = [FakeUNContent new];
    content.userInfo = @{ @"sessionId": @"session-un-42" };
    FakeUNRequest *request = [FakeUNRequest new];
    request.content = content;
    FakeUNNotification *notif = [FakeUNNotification new];
    notif.request = request;

    __block UNNotificationPresentationOptions presentedOptions = 0;
    [unDelegate userNotificationCenter:dummyCenter
               willPresentNotification:(id)notif
                 withCompletionHandler:^(UNNotificationPresentationOptions options) {
        presentedOptions = options;
    }];
    if (@available(macOS 11.0, *)) {
        NSCAssert(
            (presentedOptions & UNNotificationPresentationOptionBanner) != 0 &&
            (presentedOptions & UNNotificationPresentationOptionSound) != 0,
            @"UN delegate must present banner and sound in foreground"
        );
    } else {
        NSCAssert(presentedOptions != 0, @"UN delegate must present notification in foreground");
    }

    FakeUNResponse *response = [FakeUNResponse new];
    response.actionIdentifier = UNNotificationDefaultActionIdentifier;
    response.notification = notif;

    __block BOOL unCompleted = NO;
    gClickCount = 0;
    gLastSessionId = nil;
    [unDelegate userNotificationCenter:dummyCenter
        didReceiveNotificationResponse:(id)response
                 withCompletionHandler:^{
        unCompleted = YES;
    }];
    NSCAssert(unCompleted, @"UN delegate must invoke completionHandler");
    NSCAssert(gClickCount == 1, @"UN default action must fire click callback");
    NSCAssert([gLastSessionId isEqualToString:@"session-un-42"], @"UN click must forward sessionId");

    // Dismiss action must NOT fire click callback, but must call completionHandler.
    response.actionIdentifier = UNNotificationDismissActionIdentifier;
    unCompleted = NO;
    [unDelegate userNotificationCenter:dummyCenter
        didReceiveNotificationResponse:(id)response
                 withCompletionHandler:^{
        unCompleted = YES;
    }];
    NSCAssert(unCompleted, @"UN dismiss action must still invoke completionHandler");
    NSCAssert(gClickCount == 1, @"UN dismiss action must not fire click callback");

    // Non-string sessionId must not crash and passes NULL.
    response.actionIdentifier = UNNotificationDefaultActionIdentifier;
    content.userInfo = @{ @"sessionId": @12345 };
    [unDelegate userNotificationCenter:dummyCenter
        didReceiveNotificationResponse:(id)response
                 withCompletionHandler:^{}];
    NSCAssert(gClickCount == 2 && gLastSessionId == nil, @"non-string sessionId should safely pass nil");

    // Repeated notifications with the same tag must use unique identifiers while grouping by threadIdentifier.
    UNNotificationRequest *firstReq =
        codexhost_macos_notifications_build_un_request(@"Turn done", @"First", @"codexhost-test", @"session-1");
    UNNotificationRequest *secondReq =
        codexhost_macos_notifications_build_un_request(@"Turn done", @"Second", @"codexhost-test", @"session-1");
    NSCAssert(firstReq.identifier.length > 0 && secondReq.identifier.length > 0, @"UN identifiers must be non-empty");
    NSCAssert(![firstReq.identifier isEqualToString:@"codexhost-test"], @"UN identifier must not reuse tag");
    NSCAssert(![firstReq.identifier isEqualToString:secondReq.identifier], @"UN identifiers must be unique per delivery");
    NSCAssert([firstReq.content.threadIdentifier isEqualToString:@"codexhost-test"], @"UN threadIdentifier must preserve tag");
    NSCAssert([firstReq.content.userInfo[@"sessionId"] isEqualToString:@"session-1"], @"UN userInfo must preserve sessionId");
}

int main(int argc, char **argv) {
    @autoreleasepool {
        BOOL expectEmbeddedDebugMode = (argc > 1 && strcmp(argv[1], "--embedded-plist") == 0);
        if (expectEmbeddedDebugMode) {
            // Simulates unbundled `target/debug/codexhost-shell` built with embedded Info.plist.
            NSCAssert(
                codexhost_macos_notifications_active_backend() == 2,
                @"unbundled binary with embedded Info.plist should select legacy center, not UNUserNotificationCenter"
            );
            codexhost_macos_notifications_install(recordClick);

            int32_t perm = -1;
            codexhost_macos_notifications_get_permission(&perm, onPermission);
            NSCAssert(perm == 0, @"embedded-plist unbundled binary should report granted");

            RequestPermResult req = { -1, -1 };
            codexhost_macos_notifications_request_permission(&req, onRequestPermission);
            NSCAssert(req.permission == 0 && req.has_error == 0, @"embedded-plist request should report granted");
            return 0;
        }

        // 1. Backend selection across .app bundle, unbundled debug (embedded plist), and bare binary.
        NSCAssert(
            codexhost_macos_notifications_select_backend("com.codexhost.shell", "app", 1) == 1,
            @".app bundle should use UNUserNotificationCenter"
        );
        NSCAssert(
            codexhost_macos_notifications_select_backend("com.codexhost.shell", "APP", 0) == 1,
            @".APP bundle (case-insensitive) should use UNUserNotificationCenter"
        );
        NSCAssert(
            codexhost_macos_notifications_select_backend("com.codexhost.shell", "", 1) == 2,
            @"unbundled binary with embedded Info.plist and legacy center should use legacy center"
        );
        NSCAssert(
            codexhost_macos_notifications_select_backend("com.codexhost.shell", "", 0) == 0,
            @"unbundled binary without legacy center should report unsupported"
        );
        NSCAssert(
            codexhost_macos_notifications_select_backend(NULL, "app", 1) == 0,
            @"missing bundle identifier should report unsupported"
        );
        NSCAssert(
            codexhost_macos_notifications_select_backend("", "app", 1) == 0,
            @"empty bundle identifier should report unsupported"
        );

        // 2. Unbundled bare test binary degrades safely without throwing NSInternalInconsistencyException.
        NSCAssert(codexhost_macos_notifications_active_backend() == 0, @"bare binary should be unsupported");
        codexhost_macos_notifications_install(recordClick);

        int32_t perm = -1;
        codexhost_macos_notifications_get_permission(&perm, onPermission);
        NSCAssert(perm == 3, @"bare binary permission should be unsupported");

        RequestPermResult req = { -1, -1 };
        codexhost_macos_notifications_request_permission(&req, onRequestPermission);
        NSCAssert(req.permission == 3 && req.has_error == 0, @"bare binary request should be unsupported without error");

        int showHadError = 0;
        codexhost_macos_notifications_show("Title", "Body", "tag-1", "session-1", &showHadError, onShow);
        NSCAssert(showHadError == 1, @"bare binary show should return an error instead of crashing");

        // 3. UNUserNotificationCenterDelegate foreground presentation + click dispatch.
        if (@available(macOS 10.14, *)) {
            verifyUNDelegate();
        }

        // 4. Legacy NSUserNotificationCenterDelegate foreground presentation + click dispatch.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        NSUserNotification *firstLegacy =
            codexhost_macos_notifications_build_legacy_notification(@"Title", @"Body 1", @"codexhost-test", @"session-legacy-7");
        NSUserNotification *secondLegacy =
            codexhost_macos_notifications_build_legacy_notification(@"Title", @"Body 2", @"codexhost-test", @"session-legacy-7");
        NSCAssert(firstLegacy.identifier.length > 0 && secondLegacy.identifier.length > 0, @"legacy identifiers must be non-empty");
        NSCAssert(![firstLegacy.identifier isEqualToString:@"codexhost-test"], @"legacy identifier must not reuse tag");
        NSCAssert(![firstLegacy.identifier isEqualToString:secondLegacy.identifier], @"legacy identifiers must be unique per delivery");
        NSCAssert([firstLegacy.userInfo[@"sessionId"] isEqualToString:@"session-legacy-7"], @"legacy userInfo must preserve sessionId");

        CHLegacyNotificationDelegate *legacyDelegate = [CHLegacyNotificationDelegate sharedDelegate];
        NSUserNotification *legacyNotif = firstLegacy;
        FakeLegacyCenter *fakeCenter = [FakeLegacyCenter new];
        NSCAssert(
            [legacyDelegate userNotificationCenter:(id)fakeCenter shouldPresentNotification:legacyNotif],
            @"legacy delegate must present foreground banners"
        );

        gClickCount = 0;
        gLastSessionId = nil;
        [legacyDelegate userNotificationCenter:(id)fakeCenter didActivateNotification:legacyNotif];
        NSCAssert(gClickCount == 1, @"legacy activation must fire click callback");
        NSCAssert([gLastSessionId isEqualToString:@"session-legacy-7"], @"legacy click must forward sessionId");
        NSCAssert(fakeCenter.removed == legacyNotif, @"legacy activation must remove delivered notification");
#pragma clang diagnostic pop
    }
    return 0;
}
