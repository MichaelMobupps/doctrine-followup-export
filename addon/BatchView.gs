/**
 * When user clicks on a batch group in the homepage,
 * show the individual prospects with checkboxes for exclusion.
 *
 * Google Cards don't support real checkboxes in lists,
 * so we use a "select to exclude" model:
 * All unreplied are queued by default — tap a prospect to exclude them.
 */
function onBatchClick(e) {
  var batchData = JSON.parse(e.parameters.batch);
  var vertical = batchData.vertical;
  var sentDate = batchData.sent_date;
  var label = batchData.label;

  var groups;
  try {
    groups = apiRequest_('GET',
      '/api/prospects?vertical=' + vertical + '&replied=0'
    );
  } catch (err) {
    return buildErrorCard_('Failed to load batch', err.message);
  }

  // Find the matching group
  var group = null;
  for (var i = 0; i < groups.length; i++) {
    if (groups[i].vertical === vertical && groups[i].sent_date === sentDate) {
      group = groups[i];
      break;
    }
  }

  if (!group || group.prospects.length === 0) {
    return buildInfoCard_('No unreplied prospects in this batch');
  }

  var builder = CardService.newCardBuilder();
  builder.setHeader(
    CardService.newCardHeader()
      .setTitle(label)
      .setSubtitle(group.unreplied + ' unreplied prospects')
  );

  // ── Stage selector ──
  var stageSection = CardService.newCardSection();
  stageSection.addWidget(
    CardService.newSelectionInput()
      .setFieldName('stage')
      .setTitle('Follow-up stage')
      .setType(CardService.SelectionInputType.DROPDOWN)
      .addItem('Stage 1 (3-7 days)', '1', true)
      .addItem('Stage 2 (10-14 days)', '2', false)
      .addItem('Stage 3 (21-28 days)', '3', false)
  );
  builder.addSection(stageSection);

  // ── Prospect list ──
  // Using SelectionInput with CHECK_BOX — checked = INCLUDE (default all checked)
  var listSection = CardService.newCardSection().setHeader('Prospects (uncheck to exclude)');

  var selectionInput = CardService.newSelectionInput()
    .setFieldName('selected_ids')
    .setTitle('Select prospects')
    .setType(CardService.SelectionInputType.CHECK_BOX);

  for (var j = 0; j < group.prospects.length; j++) {
    var p = group.prospects[j];
    var daysSince = Math.floor(
      (Date.now() - new Date(p.sent_at).getTime()) / 86400000
    );

    var fuStatus = '';
    if (p.followup_1_status === 'queued') fuStatus = ' [Q1]';
    else if (p.followup_1_status === 'sent') fuStatus = ' [S1]';
    if (p.followup_2_status === 'queued') fuStatus += ' [Q2]';
    else if (p.followup_2_status === 'sent') fuStatus += ' [S2]';

    var itemLabel = p.prospect_name + ' — ' + p.company +
      ' (' + daysSince + 'd)' + fuStatus;

    // Default all checked (include)
    selectionInput.addItem(itemLabel, String(p.id), true);
  }

  listSection.addWidget(selectionInput);
  builder.addSection(listSection);

  // ── Queue button ──
  var actionSection = CardService.newCardSection();
  actionSection.addWidget(
    CardService.newTextButton()
      .setText('Queue selected follow-ups')
      .setOnClickAction(
        CardService.newAction()
          .setFunctionName('onQueueSelectedClick')
          .setParameters({
            vertical: vertical,
            sent_date: sentDate,
          })
      )
  );
  builder.addSection(actionSection);

  var card = builder.build();
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().pushCard(card))
    .build();
}
