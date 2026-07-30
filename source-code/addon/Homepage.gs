/**
 * Homepage trigger — fires when user clicks the add-on icon
 * in the Gmail sidebar (not viewing a specific email).
 *
 * Shows: stats summary, batch groups, bulk queue actions.
 */
function onHomepage(e) {
  try {
    var stats = apiRequest_('GET', '/api/stats');
    var groups = apiRequest_('GET', '/api/prospects?replied=0');
  } catch (err) {
    return buildErrorCard_('Failed to connect to backend', err.message);
  }

  var builder = CardService.newCardBuilder();
  builder.setHeader(
    CardService.newCardHeader()
      .setTitle('Doctrine Follow-up')
      .setSubtitle('Manage outreach follow-ups')
  );

  // ── Stats section ──
  var statsSection = CardService.newCardSection().setHeader('Overview');

  statsSection.addWidget(
    CardService.newDecoratedText()
      .setTopLabel('Total sent')
      .setText(String(stats.total_sent))
      .setBottomLabel(
        stats.unreplied + ' unreplied · ' +
        stats.replied + ' replied'
      )
  );

  statsSection.addWidget(
    CardService.newDecoratedText()
      .setTopLabel('Follow-ups')
      .setText(stats.queued_followups + ' queued')
      .setBottomLabel(stats.sent_followups + ' sent')
  );

  // Sync button
  statsSection.addWidget(
    CardService.newTextButton()
      .setText('Sync Gmail now')
      .setOnClickAction(
        CardService.newAction().setFunctionName('onSyncClick')
      )
  );

  builder.addSection(statsSection);

  // ── Batch groups ──
  if (groups.length > 0) {
    var batchSection = CardService.newCardSection().setHeader('Unreplied batches');

    for (var i = 0; i < Math.min(groups.length, 8); i++) {
      var g = groups[i];

      var actionData = JSON.stringify({
        vertical: g.vertical,
        sent_date: g.sent_date,
        label: g.label,
      });

      batchSection.addWidget(
        CardService.newDecoratedText()
          .setTopLabel(g.label)
          .setText(g.unreplied + ' unreplied / ' + g.total + ' total')
          .setOnClickAction(
            CardService.newAction()
              .setFunctionName('onBatchClick')
              .setParameters({ batch: actionData })
          )
          .setButton(
            CardService.newTextButton()
              .setText('Queue all')
              .setOnClickAction(
                CardService.newAction()
                  .setFunctionName('onQueueBatchClick')
                  .setParameters({
                    vertical: g.vertical,
                    sent_date: g.sent_date,
                    label: g.label,
                  })
              )
          )
      );
    }

    builder.addSection(batchSection);
  } else {
    var emptySection = CardService.newCardSection();
    emptySection.addWidget(
      CardService.newTextParagraph().setText(
        'No unreplied prospects found. Click "Sync Gmail" to pull new emails.'
      )
    );
    builder.addSection(emptySection);
  }

  // ── Scheduled follow-ups section ──
  try {
    var queued = apiRequest_('GET', '/api/followups?status=queued');
    if (queued.length > 0) {
      var queueSection = CardService.newCardSection()
        .setHeader('Scheduled (' + queued.length + ')');

      for (var j = 0; j < Math.min(queued.length, 5); j++) {
        var fu = queued[j];
        var schedDate = new Date(fu.scheduled_at).toLocaleDateString();

        queueSection.addWidget(
          CardService.newDecoratedText()
            .setTopLabel('Stage ' + fu.stage + ' · ' + schedDate)
            .setText(fu.prospect_name + ' — ' + fu.company)
            .setButton(
              CardService.newTextButton()
                .setText('Cancel')
                .setOnClickAction(
                  CardService.newAction()
                    .setFunctionName('onCancelFollowup')
                    .setParameters({ followup_id: String(fu.id) })
                )
            )
        );
      }

      if (queued.length > 5) {
        queueSection.addWidget(
          CardService.newTextParagraph().setText(
            '+ ' + (queued.length - 5) + ' more scheduled'
          )
        );
      }

      builder.addSection(queueSection);
    }
  } catch (err) {
    // Non-critical, skip
  }

  return builder.build();
}
