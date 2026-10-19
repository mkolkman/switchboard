const test = require('node:test');
const assert = require('node:assert/strict');

const { isTechnical, envFlagsInConfig, parseDotenv, flagValue, appFlagsInFile, remoteValue, productionEnvRef } = require('../observability-flags');

test('envFlagsInConfig: flag-like env keys with their default, and the ones a component names', () => {
  const files = [
    { file: 'config/services.php', text: "'members' => env('CITYROW_IMPORT_MEMBERS_ENABLED', true),\n'key' => env('STRIPE_KEY'),\n'x' => (bool) env('CITYROW_MAINTENANCE', false)," },
    { file: 'config/cityrow.php', text: "'identity_provider' => env('CITYROW_IDENTITY_PROVIDER', 'cityrow_legacy'),\n'again' => env('CITYROW_IMPORT_MEMBERS_ENABLED')," },
  ];
  assert.deepEqual(envFlagsInConfig(files, ['CITYROW_IDENTITY_PROVIDER']), [
    { key: 'CITYROW_IMPORT_MEMBERS_ENABLED', fallback: 'true', file: 'config/services.php' },
    { key: 'CITYROW_MAINTENANCE', fallback: 'false', file: 'config/services.php' },
    { key: 'CITYROW_IDENTITY_PROVIDER', fallback: 'cityrow_legacy', file: 'config/cityrow.php' },
  ]);
});

test('parseDotenv and flagValue: the .env\'s values as on, off or themselves', () => {
  const env = parseDotenv('# comment\nA_ENABLED=true\nB_ENABLED="false"\nexport C=wna\nD=\n');
  assert.deepEqual([...env], [['A_ENABLED', 'true'], ['B_ENABLED', 'false'], ['C', 'wna'], ['D', '']]);
  assert.equal(flagValue('true'), 'on');
  assert.equal(flagValue('0'), 'off');
  assert.equal(flagValue(null), 'off');
  assert.equal(flagValue('cityrow_legacy'), 'cityrow_legacy');
});

test('isTechnical: whole words of a key or a camelCase name', () => {
  assert.ok(isTechnical('PROMETHEUS_ENABLED'));
  assert.ok(isTechnical('tracingEnabled'));
  assert.ok(isTechnical('GRAPHQL_APQ_ENABLE'));
  assert.ok(!isTechnical('switch_profile_enabled_android'));
  assert.ok(!isTechnical('CITYROW_IMPORT_BADGES_ENABLED'));
});

test('appFlagsInFile: Kotlin and Swift flags by how production decides them', () => {
  const kotlin = `
private const val KEY_PROGRAMS = "programs_enabled"
object FeatureFlags {
    val editEnabled: Boolean
        get() = BuildConfig.DEBUG
    val classesEnabled: Boolean
        get() = hasAccessTo("premium")
    val lokaliseEnabled: Boolean
        get() = BuildConfig.DEBUG || InsiderStatus.isInsider
    val newAuthenticationEnabled: Boolean = true
    val debriefEnabled: Boolean
        get() = BuildConfig.DEBUG || remoteConfig.getBoolean("wrc_ai_debrief_enabled_android")
    fun programsEnabled(): Boolean {
        return BuildConfig.DEBUG || remoteConfig.getBoolean(KEY_PROGRAMS)
    }
    fun connectToFakeEnabled() = BuildConfig.DEBUG
    private fun hidden(): Boolean = true
}`;
  assert.deepEqual(appFlagsInFile(kotlin), [
    { name: 'editEnabled', how: 'debug' },
    { name: 'newAuthenticationEnabled', how: 'fixed', value: 'on' },
    { name: 'debriefEnabled', how: 'remote', key: 'wrc_ai_debrief_enabled_android' },
    { name: 'programsEnabled', how: 'remote', key: 'programs_enabled' },
    { name: 'connectToFakeEnabled', how: 'debug' },
  ]);
  const swift = `
private let keyPrograms = "programs_enabled"
enum FeatureFlags {
    public static func socialTrainingPlanEnabled() -> Bool {
        return isDebugBuild()
    }

    /// Kill switch; subscribers are checked with \`hasAccessToSessionDebrief()\`.
    public static func aiSessionDebriefEnabled() -> Bool {
        return isDebugBuild() || remoteConfig.getBool(forKey: "wrc_ai_debrief_enabled_ios")
    }
    var programsEnabled: Bool {
        #if DEBUG
            return true
        #else
            return remoteConfig.configValue(forKey: keyPrograms).boolValue
        #endif
    }
    private static func isDebugBuild() -> Bool {
        #if DEBUG
            return true
        #else
            return false
        #endif
    }
}`;
  assert.deepEqual(appFlagsInFile(swift), [
    { name: 'socialTrainingPlanEnabled', how: 'debug' },
    { name: 'aiSessionDebriefEnabled', how: 'remote', key: 'wrc_ai_debrief_enabled_ios' },
    { name: 'programsEnabled', how: 'remote', key: 'programs_enabled' },
  ]);
});

test('remoteValue: the value for everyone, and per condition by name with its rollout', () => {
  assert.deepEqual(remoteValue({
    defaultValue: { value: 'false' },
    conditionalValues: { 'MoveLab email': { value: 'true' }, 'Android 2026': { rolloutValue: { rolloutId: 'r', value: 'true', percent: 40 } } },
  }), { value: 'off', conditions: [{ name: 'MoveLab email', value: 'on', percent: null }, { name: 'Android 2026', value: 'on', percent: 40 }] });
  assert.equal(remoteValue(undefined), null);
});

test('productionEnvRef: the tag side of deploy.yml\'s 1Password reference', () => {
  const yml = "env:\n  LOCATION_1PASSWORD_ENV: ${{ startsWith(github.ref, 'refs/tags/') && 'op://vault/prod/notesPlain' || 'op://vault/dev/notesPlain' }}\n";
  assert.equal(productionEnvRef(yml), 'op://vault/prod/notesPlain');
  assert.equal(productionEnvRef('nothing'), null);
});
