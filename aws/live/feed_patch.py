"""Exact-anchor additive patch for the inspected production FYERS daemon.

Called only by the installer; preserves paper dispatcher and all existing handlers.
Unknown source layouts fail before any service/file change.
"""
MARKER = '// IOM_SEPARATE_LIVE_FEED_V1'


def patch(source):
    if MARKER in source:
        # Require our complete patch, not just a marker left in a partial edit.
        for anchor in ('liveFeed.accept(message.symbol, routed.quote, message);',
                       'liveFeed.accept(SYMBOL, result.quote, message);',
                       'mergeLiveSubscriptions(changes, subscribedSymbols, readLiveSubscriptions())'):
            if source.count(anchor) != 1: raise ValueError('INCOMPLETE_EXISTING_LIVE_FEED_PATCH')
        return source
    anchors = {
        "import { createPaperFeedDispatcher } from './paperFeedDispatcher.mjs';":
        "import { createPaperFeedDispatcher } from './paperFeedDispatcher.mjs';\n"+MARKER+"\nimport { createLiveFeedPublisher, readLiveSubscriptions, mergeLiveSubscriptions } from './liveFeedPublisher.mjs';",
        'const paperDispatcher = createPaperFeedDispatcher();':
        "const paperDispatcher = createPaperFeedDispatcher();\nconst liveFeed = createLiveFeedPublisher({ report: reason => console.log(reason) });\nconst liveFeedTimer = setInterval(() => liveFeed.flush(), 100);\nliveFeedTimer.unref();",
        '    changes = getSubscriptionChanges(\n      [...subscribedSymbols]\n    );':
        '    changes = getSubscriptionChanges(\n      [...subscribedSymbols]\n    );\n    changes = mergeLiveSubscriptions(changes, subscribedSymbols, readLiveSubscriptions());',
        "        subscriptionActive = true;":
        "        subscriptionActive = true;\n        liveFeed.status(true);",
        '        paperDispatcher.accept(message.symbol, routed.quote);':
        '        paperDispatcher.accept(message.symbol, routed.quote);\n        liveFeed.accept(message.symbol, routed.quote, message);',
        '    paperDispatcher.accept(SYMBOL, result.quote);':
        '    paperDispatcher.accept(SYMBOL, result.quote);\n    liveFeed.accept(SYMBOL, result.quote, message);',
        'function handleUnexpectedDisconnect(reason) {':
        'function handleUnexpectedDisconnect(reason) {\n  liveFeed.status(false);',
        '  stopping = true;': '  stopping = true;\n  liveFeed.status(false);'
    }
    for anchor in anchors:
        if source.count(anchor) != 1: raise ValueError('FYERS_DAEMON_LAYOUT_CHANGED')
    for anchor, value in anchors.items(): source = source.replace(anchor, value)
    return source
