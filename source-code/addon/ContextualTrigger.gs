/**
 * Contextual trigger — fires when user opens a specific email.
 * If the email is a Doctrine-sent prospect email, shows follow-up
 * status and queue controls. Otherwise shows a generic message.
 */
function onGmailMessage(e) {
  var messageId = e.gmail.messageId;

  // Get the thread ID from the current message
  var message = GmailApp.getMessageById(messageId);
  if (!message) {
    return buildInfoCard_('No message found');
  }

  var threadId = message.getThread().getId();

  // Look up this thread in our backend
  var prospect;
  try {
    prospect = apiRequest_('GET', '/api/prospect/by-thread/' + threadId);
  } catch (err) {
    // Not a Doctrine email — show generic card
    return buildNotDoctrineCard_();
  }

  return buildProspectCard_(prospect);
}

/**
 * Build the prospect detail card shown when viewing a Doctrine email.
 */
function buildProspectCard_(p) {
  var builder = CardService.newCardBuilder();

  builder.setHeader(
    CardService.newCardHeader()
      .setTitle(p.prospect_name || 'Unknown')
      .setSubtitle(p.company || '')
  );

  // ── Prospect info ──
  var infoSection = CardService.newCardSection().setHeader('Prospect');

  var daysSince = Math.floor(
    (Date.now() - new Date(p.sent_at).getTime()) / 86400000
  );

  var verticalLabels = {
    gaming_ua: 'Gaming UA',
    non_gaming_ua: 'Non-Gaming UA',
    cps: 'CPS / Fintech',
    retargeting: 'Retargeting',
  };

  infoSection.addWidget(
    CardService.newDecoratedText()
      .setTopLabel('Vertical')
      .setText(verticalLabels[p.vertical] || p.vertical)
  );

  infoSection.addWidget(
    CardService.newDecoratedText()
      .setTopLabel('Sent')
      .setText(daysSince + ' days ago')
  );

  infoSection.addWidget(
    CardService.newDecoratedText()
      .setTopLabel('Status')
      .setText(p.replied ? '✓ Replied' : '✗ No reply')
  );

  builder.addSection(infoSection);

  // ── Follow-up status ──
  var fuSection = CardService.newCardSection().setHeader('Follow-ups');

  var stages = [
    { num: 1, status: p.followup_1_status, scheduled: p.followup_1_scheduled },
    { num: 2, status: p.followup_2_status, scheduled: p.followup_2_scheduled },
    { num: 3, status: p.followup_3_status, scheduled: p.followup_3_scheduled },
  ];

  for (var i = 0; i < stages.length; i++) {
    var s = stages[i];
    var statusText = '—';
    if (s.status === 'queued') {
      statusText = 'Queued → ' + new Date(s.scheduled).toLocaleDateString();
    } else if (s.status === 'sent') {
      statusText = '✓ Sent';
    } else if (s.status === 'failed') {
      statusText = '✗ Failed';
    } else if (s.status === 'cancelled') {
      statusText = 'Cancelled';
    }

    fuSection.addWidget(
      CardService.newDecoratedText()
        .setTopLabel('Stage ' + s.num)
        .setText(statusText)
    );
  }

  builder.addSection(fuSection);

  // ── Actions (only if not replied) ──
  if (!p.replied) {
    var actionSection = CardService.newCardSection().setHeader('Actions');

    // Find next available stage
    var nextStage = 1;
    if (p.followup_1_status === 'queued' || p.followup_1_status === 'sent') nextStage = 2;
    if (p.followup_2_status === 'queued' || p.followup_2_status === 'sent') nextStage = 3;
    if (p.followup_3_status === 'queued' || p.followup_3_status === 'sent') nextStage = 0;

    if (nextStage > 0 && nextStage <= 3) {
      actionSection.addWidget(
        CardService.newTextButton()
          .setText('Queue stage ' + nextStage + ' follow-up')
          .setOnClickAction(
            CardService.newAction()
              .setFunctionName('onQueueSingleClick')
              .setParameters({
                prospect_id: String(p.id),
                stage: String(nextStage),
              })
          )
      );
    } else if (nextStage === 0) {
      actionSection.addWidget(
        CardService.newTextParagraph().setText('All 3 stages complete.')
      );
    }

    // Cancel buttons for queued stages
    for (var j = 0; j < stages.length; j++) {
      if (stages[j].status === 'queued') {
        actionSection.addWidget(
          CardService.newTextButton()
            .setText('Cancel stage ' + stages[j].num)
            .setOnClickAction(
              CardService.newAction()
                .setFunctionName('onCancelByProspectStage')
                .setParameters({
                  prospect_id: String(p.id),
                  stage: String(stages[j].num),
                })
            )
        );
      }
    }

    builder.addSection(actionSection);
  }

  return builder.build();
}

/**
 * Shown when the open email is not a Doctrine-tracked prospect.
 */
function buildNotDoctrineCard_() {
  var builder = CardService.newCardBuilder();
  builder.setHeader(
    CardService.newCardHeader()
      .setTitle('Doctrine Follow-up')
      .setSubtitle('Not a tracked email')
  );

  var section = CardService.newCardSection();
  section.addWidget(
    CardService.newTextParagraph().setText(
      'This email is not tracked by Doctrine. ' +
      'Only emails sent with a Doctrine label appear here.'
    )
  );

  section.addWidget(
    CardService.newTextButton()
      .setText('← Back to dashboard')
      .setOnClickAction(
        CardService.newAction().setFunctionName('onHomepage')
      )
  );

  builder.addSection(section);
  return builder.build();
}
