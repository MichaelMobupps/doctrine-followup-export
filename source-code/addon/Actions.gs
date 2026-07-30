/**
 * ── Action handlers ──
 * Each function is called by a button/action in the card UI.
 * They call the backend API and return updated cards.
 */

// ── Sync Gmail ──

function onSyncClick(e) {
  try {
    // Scope the sync to the user who clicked the button. Without this, the
    // backend syncs every connected tenant on every click and the request
    // blocks until they all finish — which times out as more accounts
    // connect.
    var activeEmail = '';
    try {
      activeEmail = Session.getActiveUser().getEmail() || '';
    } catch (sessionErr) {
      // Some restricted Workspace configurations don't expose the active
      // user's email to add-ons. In that case fall through to a backend
      // all-users sync — same behavior as before this fix. Log so we can
      // tell from Apps Script execution logs that the fallback fired
      // (vs. silently syncing every tenant on every click).
      try { Logger.log('Session.getActiveUser failed: ' + sessionErr); } catch (_e) {}
      activeEmail = '';
    }

    var payload = activeEmail ? { email: activeEmail } : null;
    var result = apiRequest_('POST', '/api/sync', payload);
    return notify_(
      'Synced ' + result.synced + ' emails, ' +
      result.repliesDetected + ' new replies detected'
    );
  } catch (err) {
    return notify_('Sync failed: ' + err.message);
  }
}

// ── Queue entire batch (from homepage "Queue all" button) ──

function onQueueBatchClick(e) {
  var vertical = e.parameters.vertical;
  var sentDate = e.parameters.sent_date;
  var label = e.parameters.label;

  try {
    var result = apiRequest_('POST', '/api/queue-batch', {
      vertical: vertical,
      sent_date: sentDate,
      stage: 1, // Default to stage 1 from quick-queue
    });

    if (result.queued > 0) {
      var earliest = new Date(result.scheduled_range.earliest).toLocaleDateString();
      var latest = new Date(result.scheduled_range.latest).toLocaleDateString();
      return notify_(
        'Queued ' + result.queued + ' follow-ups (' + earliest + ' – ' + latest + ')'
      );
    } else {
      return notify_('No new follow-ups queued (may already be scheduled)');
    }
  } catch (err) {
    return notify_('Queue failed: ' + err.message);
  }
}

// ── Queue selected prospects from batch detail view ──

function onQueueSelectedClick(e) {
  var formInputs = e.commonEventObject.formInputs || {};

  // Get selected IDs from checkbox input
  var selectedRaw = formInputs.selected_ids;
  var selectedIds = [];
  if (selectedRaw && selectedRaw.stringInputs && selectedRaw.stringInputs.value) {
    selectedIds = selectedRaw.stringInputs.value.map(function(id) {
      return parseInt(id);
    });
  }

  // Get stage from dropdown
  var stageRaw = formInputs.stage;
  var stage = 1;
  if (stageRaw && stageRaw.stringInputs && stageRaw.stringInputs.value) {
    stage = parseInt(stageRaw.stringInputs.value[0]) || 1;
  }

  if (selectedIds.length === 0) {
    return notify_('No prospects selected');
  }

  try {
    var result = apiRequest_('POST', '/api/queue', {
      prospect_ids: selectedIds,
      stage: stage,
    });

    if (result.queued > 0) {
      var earliest = new Date(result.scheduled_range.earliest).toLocaleDateString();
      var latest = new Date(result.scheduled_range.latest).toLocaleDateString();
      return notify_(
        'Queued ' + result.queued + ' stage ' + stage +
        ' follow-ups (' + earliest + ' – ' + latest + ')'
      );
    } else {
      return notify_('No new follow-ups queued (may already be scheduled)');
    }
  } catch (err) {
    return notify_('Queue failed: ' + err.message);
  }
}

// ── Queue single prospect (from contextual email view) ──

function onQueueSingleClick(e) {
  var prospectId = parseInt(e.parameters.prospect_id);
  var stage = parseInt(e.parameters.stage);

  try {
    var result = apiRequest_('POST', '/api/queue', {
      prospect_ids: [prospectId],
      stage: stage,
    });

    if (result.queued > 0) {
      var schedDate = new Date(result.scheduled_range.earliest).toLocaleDateString();
      return notify_('Stage ' + stage + ' queued for ' + schedDate);
    } else {
      return notify_('Already scheduled');
    }
  } catch (err) {
    return notify_('Queue failed: ' + err.message);
  }
}

// ── Cancel a follow-up by ID ──

function onCancelFollowup(e) {
  var followupId = parseInt(e.parameters.followup_id);

  try {
    var result = apiRequest_('POST', '/api/cancel', {
      followup_ids: [followupId],
    });
    return notify_('Cancelled ' + result.cancelled + ' follow-up(s)');
  } catch (err) {
    return notify_('Cancel failed: ' + err.message);
  }
}

// ── Cancel by prospect + stage (from contextual view) ──

function onCancelByProspectStage(e) {
  var prospectId = parseInt(e.parameters.prospect_id);
  var stage = parseInt(e.parameters.stage);

  // Need to find the followup ID — fetch followups for this prospect
  try {
    var followups = apiRequest_('GET', '/api/followups?status=queued');

    var matchId = null;
    for (var i = 0; i < followups.length; i++) {
      if (followups[i].prospect_id === prospectId && followups[i].stage === stage) {
        matchId = followups[i].id;
        break;
      }
    }

    if (!matchId) {
      return notify_('No queued follow-up found for this stage');
    }

    var result = apiRequest_('POST', '/api/cancel', {
      followup_ids: [matchId],
    });
    return notify_('Stage ' + stage + ' cancelled');
  } catch (err) {
    return notify_('Cancel failed: ' + err.message);
  }
}

// ── Helper: show a notification ──

function notify_(message) {
  return CardService.newActionResponseBuilder()
    .setNotification(
      CardService.newNotification().setText(message)
    )
    .build();
}

// ── Helper: build an error card ──

function buildErrorCard_(title, detail) {
  var builder = CardService.newCardBuilder();
  builder.setHeader(
    CardService.newCardHeader().setTitle(title)
  );

  var section = CardService.newCardSection();
  section.addWidget(
    CardService.newTextParagraph().setText(detail || 'Unknown error')
  );

  section.addWidget(
    CardService.newTextParagraph().setText(
      'Check that your backend is running and BACKEND_URL / API_KEY ' +
      'are set correctly in Script Properties.'
    )
  );

  builder.addSection(section);
  return builder.build();
}

// ── Helper: build a simple info card ──

function buildInfoCard_(message) {
  var builder = CardService.newCardBuilder();
  builder.setHeader(
    CardService.newCardHeader().setTitle('Doctrine Follow-up')
  );

  var section = CardService.newCardSection();
  section.addWidget(
    CardService.newTextParagraph().setText(message)
  );
  builder.addSection(section);
  return builder.build();
}
