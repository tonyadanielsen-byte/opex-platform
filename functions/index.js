const { onValueCreated } = require('firebase-functions/v2/database');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { getMessaging } = require('firebase-admin/messaging');

initializeApp();

function collectTokens(pushTokensRoot) {
  const tokens = [];
  if (!pushTokensRoot || typeof pushTokensRoot !== 'object') return tokens;

  for (const devices of Object.values(pushTokensRoot)) {
    if (!devices || typeof devices !== 'object') continue;
    for (const device of Object.values(devices)) {
      if (device && typeof device.token === 'string' && device.token.trim()) {
        tokens.push(device.token.trim());
      }
    }
  }

  return [...new Set(tokens)].slice(0, 500);
}

exports.notifyNewTaskV1B = onValueCreated(
  {
    ref: '/tiltak/{taskId}',
    instance: 'opex-nortura-default-rtdb',
    region: 'europe-west1',
    memory: '256MiB',
    timeoutSeconds: 60,
    maxInstances: 2,
  },
  async (event) => {
    const task = event.data.val() || {};
    const taskId = event.params.taskId;

    // V1B.1 is deliberately conservative: no notifications for test data,
    // archived/lifecycle-terminal items, or malformed imports.
    if (task.miljo === 'Test') return;
    if (!task.tittel || !task.eier) return;
    if (['Fullført', 'Stanset', 'Avsluttet'].includes(task.status)) return;

    const snapshot = await getDatabase().ref('/pushTokens').get();
    const tokens = collectTokens(snapshot.val());
    if (!tokens.length) {
      console.log('Push V1B: no registered devices; skipping', { taskId });
      return;
    }

    const title = 'Nytt tiltak i OpEx Hub';
    const body = `${task.eier}: ${task.tittel}`;

    const response = await getMessaging().sendEachForMulticast({
      tokens,
      data: {
        title,
        body,
        link: '/opex-platform/',
        tag: `opex-new-task-${taskId}`,
        eventType: 'new-task-v1b',
        taskId: String(taskId),
        owner: String(task.eier),
      },
      webpush: {
        headers: {
          Urgency: 'high',
          TTL: '300',
        },
      },
    });

    console.log('Push V1B new-task result', {
      taskId,
      owner: task.eier,
      registeredDevices: tokens.length,
      successCount: response.successCount,
      failureCount: response.failureCount,
    });
  }
);
