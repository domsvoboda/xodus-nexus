import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { backendSourceArchiveArgs } from '../backend-source-archive.mjs';

test('manifest-selected plain package executables keep licensing and encrypted-library handling (#239)',async()=>{
  const lock=JSON.parse(await fs.readFile('assets/backend-source.lock.json','utf8'));
  const entry=lock.patches.find(value=>value.file==='xodus-plain-launch-entry.patch');assert.ok(entry);
  const patch=await fs.readFile('assets/'+entry.file,'utf8');
  assert.equal(createHash('sha256').update(patch).digest('hex'),entry.sha256);
  assert.ok(lock.patches.findIndex(value=>value.file===entry.file)>lock.patches.findIndex(value=>value.file==='xodus-launch-filesystem.patch'));
  assert.deepEqual([...patch.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map(value=>value[1]),['crates/xodus-cli/src/commands/run.rs']);
  for(const name of ['plain_launch_entry_uses_only_declared_package_images_and_preserves_sources',
    'plain_launch_entry_never_treats_an_encrypted_or_undeclared_file_as_plaintext',
    'plain_launch_entry_rejects_ambiguous_metadata_and_outside_package_links',
    'launch_entry_prefers_exact_case_and_refuses_ambiguous_case_fallbacks'])assert.ok(patch.includes(name),name);
  const added=patch.split('\n').filter(line=>line.startsWith('+')&&!line.startsWith('+++')).join('\n');
  assert.match(added,/if content\.keep_encrypted \{ return Ok\(None\); \}/);
  assert.match(added,/resolve_package_file\(source, name\)/);
  assert.match(added,/open_launch_image\(&source\.join\(relative\), &actual_name, content\)/);
  assert.match(added,/inherit_launch_image\(file, &actual_name\)/);
  assert.match(added,/ambiguous package launch images/);
  assert.doesNotMatch(added,/get_license|tokens\.|full_key|Command::|set_permissions|mount_mem_fd|\.unpack\(/);
});

test('launch views require actual symbolic-link support and fall back only once (#341)',async()=>{
  const lock=JSON.parse(await fs.readFile('assets/backend-source.lock.json','utf8'));
  const entry=lock.patches.find(value=>value.file==='xodus-launch-filesystem.patch');assert.ok(entry);
  const patch=await fs.readFile('assets/'+entry.file,'utf8');
  assert.equal(createHash('sha256').update(patch).digest('hex'),entry.sha256);
  assert.deepEqual([...patch.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map(value=>value[1]),['crates/xodus-cli/src/commands/run.rs']);
  for(const name of ['probe_launch_view_links','launch_directory_falls_back_when_install_filesystem_cannot_create_links',
    'launch_directory_keeps_supported_install_filesystem_and_cleans_probe','launch_directory_does_not_hide_unrelated_io_failures_or_retry_forever'])assert.ok(patch.includes(name),name);
  const added=patch.split('\n').filter(line=>line.startsWith('+')&&!line.startsWith('+++')).join('\n');
  assert.match(added,/nix::libc::EPERM \| nix::libc::EOPNOTSUPP \| nix::libc::ENOSYS/);
  assert.match(added,/launch_view_directory\(source_root, "\.xodus-chain-"\)/);
  assert.match(added,/launch_view_directory\(source_root, "\.xodus-offline-"\)/);
  assert.doesNotMatch(added,/get_license|tokens\.|full_key|Command::|set_permissions|mount\(|chmod|copy\(/);
});

test('Xbox friends/chat is explicit and account-bound without modifying login, saves or license paths', async () => {
  const lock=JSON.parse(await fs.readFile('assets/backend-source.lock.json','utf8'));
  const entry=lock.patches.find(p=>p.file==='xodus-social.patch');assert.ok(entry);
  const patch=await fs.readFile('assets/'+entry.file,'utf8');
  assert.equal(createHash('sha256').update(patch).digest('hex'),entry.sha256);
  assert.ok(lock.patches.findIndex(p=>p.file===entry.file)>lock.patches.findIndex(p=>p.file==='xodus-session-recovery.patch'));
  assert.deepEqual([...patch.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map(m=>m[1]).sort(),[
    'crates/xodus-cli/src/commands.rs','crates/xodus-cli/src/commands/profile.rs','crates/xodus-cli/src/commands/social.rs','crates/xodus-cli/src/main.rs',
  ]);
  for(const name of ['social_input_rejects_arbitrary_endpoints_and_invalid_ids_before_authentication',
    'social_plans_use_only_exact_https_hosts_and_no_retry_or_identity_impersonation',
    'social_friends_keep_unknown_presence_honest_and_drop_private_server_fields',
    'social_chat_preserves_safety_filters_and_never_fetches_media',
    'social_send_success_requires_actual_service_acknowledgement',
    'social_http_uses_one_explicit_request_and_honors_denials_without_retry',
    'social_empty_conversation_can_omit_participants_without_inventing_messages_or_identity',
    'social_friend_picture_is_optional_and_only_uses_exact_trusted_image_hosts',
    'social_http_accepts_empty_thread_without_participants_and_never_posts_a_read_marker'])assert.ok(patch.includes(name),name);
  const production=patch.split('+#[cfg(test)]')[0];
  assert.ok(production.includes('super::profile::xbox_session(tokens)'));
  assert.ok(production.includes('username != account'));
  assert.ok(production.includes('16385'));
  assert.ok(production.includes('unsuitableFor'));
  assert.ok(production.includes('value["participants"].is_null() && messages.is_empty()'));
  assert.ok(production.includes('NEXUS_SOCIAL_DIAGNOSTIC_V1 {scope} {status}'));
  assert.ok(!patch.includes('NEXUS_PRIVATE_SOCIAL_SHAPE'));
  assert.doesNotMatch(production,/\.read_to_string\(|allow_invalid|danger_accept|mark.read|readHorizon|\.delete\(|ensure_device_credentials|NEXUS_.*token/i);
  assert.ok((await fs.readFile('scripts/build-backend.mjs','utf8')).includes("'social'"));
});

test('bundle resolution follows declared contents and preserves contributor regressions (#273, #298)', async () => {
  const lock = JSON.parse(await fs.readFile('assets/backend-source.lock.json', 'utf8'));
  const entry = lock.patches.find(p => p.file === 'xodus-bundle-membership.patch');
  assert.ok(entry);
  const patch = await fs.readFile(`assets/${entry.file}`, 'utf8');
  assert.equal(createHash('sha256').update(patch).digest('hex'), entry.sha256);
  assert.ok(lock.patches.findIndex(p => p.file === entry.file) >
    lock.patches.findIndex(p => p.file === 'xodus-package-selection.patch'));
  const files = [...patch.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map(match => match[1]);
  assert.deepEqual(files.sort(), [
    'crates/xodus-cli/src/package_plan.rs', 'crates/xodus-cli/src/package_plan_http_tests.rs',
  ].sort());
  for (const expected of ['premium_entitlement_links_do_not_walk_back_to_parent_or_foreign_games',
    'premium_license_only_addon_never_selects_a_game_that_grants_it',
    'premium_game_entitlement_is_not_bundle_membership_either',
    'premium_http_only_reads_declared_bundle_members',
    'premium_http_reports_exact_status_without_exposing_response_body',
    'premium_unavailable_declared_member_still_stops_resolution',
    'premium_nested_bundles_keep_real_addon_choices_and_explicit_selection',
    'premium_bundle_depth_and_product_limits_still_fail_closed']) assert.ok(patch.includes(expected), expected);
  assert.ok((await fs.readFile('assets/xodus-package-selection.patch', 'utf8'))
    .includes('durable_entitlement_back_references_do_not_form_bundle_cycles'));
  assert.doesNotMatch(patch, /diff --git a\/.*(?:tokens\/|licensing\/|license\.rs|login\.rs|session\.rs|streaming\.rs)/);
  const added = patch.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).join('\n');
  assert.doesNotMatch(added, /licensed\.into_iter|error_for_status|\.text\(\)|\.bytes\(\)|println!/);
  assert.ok(patch.includes("skeltavik"));
});

test('both Microsoft sign-in steps retain broker identity without changing credentials or UI trust (#260)', async () => {
  const lock = JSON.parse(await fs.readFile('assets/backend-source.lock.json', 'utf8'));
  const entry = lock.patches.find(p => p.file === 'xodus-hosted-signin.patch');
  assert.ok(entry);
  const patch = await fs.readFile(`assets/${entry.file}`, 'utf8');
  assert.equal(createHash('sha256').update(patch).digest('hex'), entry.sha256);
  const files = [...patch.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map(match => match[1]);
  assert.deepEqual(files.sort(), [
    'crates/xodus-cli/src/webview.rs', 'crates/xodus-cli/src/webview_stdio.rs',
    'crates/xodus-cli/src/webview_host_tests.rs',
  ].sort());
  for (const expected of ['hosted_signin_both_legs_keep_all_nine_headers_and_exact_targets',
    'hosted_signin_correlation_is_a_fresh_uuid_for_every_request',
    'hosted_signin_transport_emits_complete_headers_on_the_second_leg']) assert.ok(patch.includes(expected), expected);
  assert.equal((patch.match(/^\+fn host_headers\(\) -> HeaderMap/gm) ?? []).length, 2);
  assert.equal((patch.match(/^\+mod hosted_signin_tests;/gm) ?? []).length, 2);
  assert.doesNotMatch(patch, /diff --git a\/.*(?:tokens\/|login\.rs|license\.rs|keyring|auth-protocol|auth-browser|auth-window)/);
  assert.ok(patch.includes("Wyze3306"));
});

test('JWE support changes only licensing ticket formatting, not Xbox or Store authentication (#294)', async () => {
  const lock = JSON.parse(await fs.readFile('assets/backend-source.lock.json', 'utf8'));
  const entry = lock.patches.find(p => p.file === 'xodus-licensing-jwe.patch');
  assert.ok(entry);
  const patch = await fs.readFile(`assets/${entry.file}`, 'utf8');
  assert.equal(createHash('sha256').update(patch).digest('hex'), entry.sha256);
  assert.ok(lock.patches.findIndex(p => p.file === entry.file) >
    lock.patches.findIndex(p => p.file === 'xodus-store-ticket.patch'));
  for (const expected of ['pub fn licensing_ticket', 'fn is_compact_jwe',
    'content_ticket_jwe_is_bare_only_at_the_licensing_boundary',
    'content_ticket_opaque_compact_and_delegation_forms_stay_byte_exact',
    'content_ticket_dotted_or_malformed_values_are_not_reinterpreted_as_jwe',
    'content_ticket_content_request_preserves_jwe_and_other_license_fields',
    'store_license_jwe_keeps_existing_request_and_opaque_ticket_behavior']) assert.ok(patch.includes(expected), expected);
  const files = [...patch.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map(match => match[1]);
  assert.deepEqual(files.sort(), [
    'crates/xodus-cli/src/license.rs', 'crates/xodus-service/src/store_license.rs',
    'crates/xodus/src/licensing/content_response_tests.rs',
    'crates/xodus/src/models/licensing_ticket_tests.rs', 'crates/xodus/src/models/secrets.rs',
  ].sort());
  const removed = patch.split('\n').filter(line => line.startsWith('-') && !line.startsWith('---'));
  assert.deepEqual(removed, Array(2).fill('-    let user_token = xodus::models::secrets::store_ticket(user_token);'));
  assert.equal((patch.match(/^\+    let user_token = xodus::models::secrets::licensing_ticket\(user_token\);$/gm) ?? []).length, 2);
  const build = await fs.readFile('scripts/build-backend.mjs', 'utf8');
  assert.ok(build.includes("'-p', 'xodus', 'content_ticket_'"));
});

test('auth response consistency and coherent credential persistence are pinned and account-free tested', async () => {
  const lock = JSON.parse(await fs.readFile('assets/backend-source.lock.json', 'utf8'));
  assert.ok(lock.patches.some(p => p.file === 'xodus-auth-consistency.patch'));
  const patch = await fs.readFile('assets/xodus-auth-consistency.patch', 'utf8');
  for (const expected of ['impl TryFrom<soap::RequestSecurityTokenResponse>', 'save_user_session',
    'credential_login_session_failed_write_preserves_previous_session_and_empty_set_is_refused',
    'credential_login_session_readback_failure_never_exposes_mixed_account_and_token',
    'credential_token_response_valid_compact_delegation_and_legacy_remain_supported',
    'credential_invalid_device_proof_returns_an_error_before_any_request']) assert.ok(patch.includes(expected), expected);
  assert.doesNotMatch(patch, /^\+.*(?:verify_and_decrypt_envelope|\.scope_policy\(|\.hosting_app\()/m);
});

test('metadata recovery, consumer-independent timeout and empty-file updates are pinned and tested', async () => {
  const lock = JSON.parse(await fs.readFile('assets/backend-source.lock.json', 'utf8'));
  assert.ok(lock.patches.some(p => p.file === 'xodus-metadata-recovery.patch'));
  const patch = await fs.readFile('assets/xodus-metadata-recovery.patch', 'utf8');
  for (const expected of ['streaming_metadata_empty_reconnects_stop_after_retry_limit',
    'streaming_metadata_header_and_body_waits_have_deadlines',
    'streaming_http_disk_or_consumer_delay_is_not_network_idle_time',
    'streaming_updated_file_is_trimmed_even_when_its_expected_length_is_zero_or_complete',
    'streaming_metadata_failure_returns_error_without_panic_or_touching_existing_game']) assert.ok(patch.includes(expected), expected);
  const build = await fs.readFile('scripts/build-backend.mjs', 'utf8');
  assert.ok(build.includes("'-p', 'msixvc', 'streaming::tests'"));
});

test('ticket diagnostics preserve requests, signature verification and non-retryable refusals', async () => {
  const lock = JSON.parse(await fs.readFile('assets/backend-source.lock.json', 'utf8'));
  assert.ok(lock.patches.some(p => p.file === 'xodus-ticket-diagnostics.patch'));
  const patch = await fs.readFile('assets/xodus-ticket-diagnostics.patch', 'utf8');
  for (const text of ['NEXUS_TICKET_DIAGNOSTIC_V1', 'ticket-response-signature', 'ticket-response-parse', 'ticket-interaction-required',
    'ticket_diagnostic_classifies_without_disclosing_error_payloads', 'ticket_fault_classification_and_provider_codes_are_strictly_bounded',
    'matches!(self, Self::Timeout | Self::Connect | Self::Network)']) assert.ok(patch.includes(text), text);
  assert.doesNotMatch(patch, /diff --git a\/.*(?:tokens\/|login\.rs|rst\/|streaming\.rs|package_plan\.rs)/);
  assert.doesNotMatch(patch, /^[+-].*(?:verify_and_decrypt_envelope|scope_policy|hosting_app|\.send\(\)|\.save_|\.remove_)/m);
  const build = await fs.readFile('scripts/build-backend.mjs', 'utf8');
  assert.ok(build.includes("'-p', 'xodus', 'ticket_diagnostic_'"));
});

test('bandwidth limit is pinned, aggregate, live controllable and does not change authentication', async () => {
  const lock = JSON.parse(await fs.readFile('assets/backend-source.lock.json', 'utf8'));
  assert.ok(lock.patches.some(p => p.file === 'xodus-download-bandwidth.patch'));
  const patch = await fs.readFile('assets/xodus-download-bandwidth.patch', 'utf8');
  for (const expected of ['download_limit_kib', 'set-download-limit', 'OnceLock', 'streaming_bandwidth_is_aggregate_across_parallel_streams',
    'streaming_bandwidth_limited_http_metadata_and_parallel_ranges_keep_bytes_and_do_not_timeout',
    'streaming_bandwidth_update_and_unlimited_wake_active_waiters', 'streaming_bandwidth_cancellation_leaves_no_reserved_delay']) assert.ok(patch.includes(expected), expected);
  assert.doesNotMatch(patch, /diff --git a\/.*(?:tokens\/|login\.rs|session\.rs|package_plan\.rs)/);
  const build = await fs.readFile('scripts/build-backend.mjs', 'utf8');
  assert.match(build, /'streaming_bandwidth_', '--', '--ignored', '--test-threads=1'/);
  assert.ok(build.includes("'--download-limit-kib'"));
  const main = await fs.readFile('src/main/index.ts', 'utf8');
  assert.match(main, /if \(isBandwidthOnlyPatch\(patch\)\) \{ emitSnapshot\(\); return settings; \}/);
  assert.ok(main.indexOf('if (isBandwidthOnlyPatch(patch))') < main.indexOf('backend.setExternalRoot(settings.externalXodusRoot)'));
});

test('cached metadata handoff cannot park the aggregate download limiter', async () => {
  const lock = JSON.parse(await fs.readFile('assets/backend-source.lock.json', 'utf8'));
  assert.ok(lock.patches.some(p => p.file === 'xodus-streaming-handoff.patch'));
  const patch = await fs.readFile('assets/xodus-streaming-handoff.patch', 'utf8');
  assert.ok(patch.includes('if self.cached_len >= target_end'));
  assert.ok(patch.includes('streaming_bandwidth_cached_prefix_handoff_does_not_park_the_limiter'));
  assert.ok(patch.includes('timeout(Duration::from_secs(2), range.next())'));
  assert.doesNotMatch(patch, /diff --git a\/.*(?:tokens\/|login\.rs|license\.rs|package_plan\.rs)/);
  const build = await fs.readFile('scripts/build-backend.mjs', 'utf8');
  assert.match(build, /'streaming_bandwidth_', '--', '--ignored', '--test-threads=1'/);
});

test('encrypted resume retains complete ciphertext pages and launch errors identify incomplete images (#248)', async () => {
  const lock = JSON.parse(await fs.readFile('assets/backend-source.lock.json', 'utf8'));
  const resumeIndex = lock.patches.findIndex(p => p.file === 'xodus-encrypted-resume.patch');
  const launchIndex = lock.patches.findIndex(p => p.file === 'xodus-launch-image-errors.patch');
  assert.ok(resumeIndex >= 0 && launchIndex > resumeIndex);
  const resume = await fs.readFile('assets/xodus-encrypted-resume.patch', 'utf8');
  for (const name of ['streaming_resume_completed_encrypted_image_preserves_ciphertext_tail',
    'streaming_resume_repairs_old_encrypted_tail_with_actual_range_download',
    'streaming_repair_selection_preserves_unchanged_files_and_only_targets_current_package',
    'streaming_encrypted_download_and_partial_resume_keep_exact_ciphertext_for_launch_decryption',
    'streaming_plain_output_remains_unpadded_and_short_ciphertext_returns_error']) assert.ok(resume.includes(name), name);
  assert.ok(resume.includes('content.stored_length()?'));
  assert.ok(resume.includes('offset = content.length / page_size * page_size;'));
  const launch = await fs.readFile('assets/xodus-launch-image-errors.patch', 'utf8');
  for (const name of ['launch_image_preflight_rejects_incomplete_ciphertext_with_file_and_size_without_writing',
    'launch_image_preflight_accepts_valid_plain_and_padded_images_without_changes',
    'launch_images_keep_owned_descriptors_with_inheritance_enabled']) assert.ok(launch.includes(name), name);
  assert.match(launch, /^-\s*\.unwrap\(\);$/m);
  assert.match(launch, /^\+\s*Err\(error\) => \{/m);
  assert.doesNotMatch(resume + launch, /diff --git a\/.*(?:tokens\/|login\.rs|license\.rs|package_plan\.rs)/);
});

test('backend source and ordered patch hashes are locked', async () => {
  const lock = JSON.parse(await fs.readFile('assets/backend-source.lock.json', 'utf8'));
  assert.equal(lock.schema, 1);
  assert.match(lock.commit, /^[a-f0-9]{40}$/);
  assert.match(lock.cargoLockSha256, /^[a-f0-9]{64}$/);
  assert.match(lock.version, /^\d+\.\d+\.\d+$/);
  assert.equal(lock.patches.length, new Set(lock.patches.map(p => p.file)).size);
  for (const patch of lock.patches) {
    assert.match(patch.file, /^xodus-[a-z-]+\.patch$/);
    assert.equal(createHash('sha256').update(await fs.readFile(`assets/${patch.file}`)).digest('hex'), patch.sha256);
  }
});

test('social send retains a genuine server receipt without changing authentication or automatically retrying', async () => {
  const lock=JSON.parse(await fs.readFile('assets/backend-source.lock.json','utf8'));
  assert.ok(lock.patches.findIndex(p=>p.file==='xodus-social-send-receipt.patch')>lock.patches.findIndex(p=>p.file==='xodus-social.patch'));
  const patch=await fs.readFile('assets/xodus-social-send-receipt.patch','utf8');
  assert.ok(patch.includes('"messageId":id'));
  assert.ok(patch.includes('NEXUS_SOCIAL_RECEIPT_V1 {} {} {nudge} {}'));
  assert.doesNotMatch(patch,/diff --git a\/.*(?:tokens\/|login\.rs|run\.rs|streaming\.rs|license\.rs)/);
  assert.doesNotMatch(patch,/^\+.*(?:client\.(?:post|put|delete)|request\.send\(|sleep\()/m);
});

test('first wallet creation is explicit, native-prompt only and preserves existing collections', async () => {
  const lock = JSON.parse(await fs.readFile('assets/backend-source.lock.json', 'utf8'));
  const index = lock.patches.findIndex(p => p.file === 'xodus-keyring-create.patch');
  assert.ok(index > lock.patches.findIndex(p => p.file === 'xodus-keyring-persistence.patch'));
  const patch = await fs.readFile('assets/xodus-keyring-create.patch', 'utf8');
  for (const text of ['KeyringCreate', 'CreateCollection', 'if !collections.is_empty()', 'current_owner != owner',
    'keyring_create_never_replaces_existing_collections_or_creates_from_unlock',
    'keyring_create_native_prompt_rechecks_default_and_lock_state',
    'keyring_create_cancel_timeout_and_foreign_completion_are_bounded']) assert.ok(patch.includes(text),text);
  assert.doesNotMatch(patch, /^\+.*(?:GetSecret|SearchItems|SetSecret|SetAlias|ensure_device_credentials\(|https:\/\/)/m);
  const build = await fs.readFile('scripts/build-backend.mjs','utf8');
  assert.ok(build.includes("'keyring_create_', '--', '--test-threads=1'"));
  assert.ok(build.includes("'keyring-create'"));
});

test('wallet unlock is explicit, account-free and private-bus tested', async () => {
  const lock = JSON.parse(await fs.readFile('assets/backend-source.lock.json', 'utf8'));
  assert.ok(lock.patches.some(p => p.file === 'xodus-keyring-unlock.patch'));
  const patch = await fs.readFile('assets/xodus-keyring-unlock.patch', 'utf8');
  for (const text of ['KeyringUnlock', 'keyring_unlock_private_bus_metadata_never_activates_or_reads_items',
    'keyring_unlock_private_bus_ignores_completion_from_another_owner', 'keyring_unlock_private_bus_cancellation_and_timeout_dismiss_the_prompt',
    'keyring_unlock_private_bus_prompt_connection_completion_and_lock_recheck', 'connection.remove_match(token)',
    'keyring_unlock_prompt_never_tags_unrelated_or_unparented_windows',
    'keyring_unlock_prompt_uses_only_the_verified_parent_app', 'keyring_unlock_prompt_reaper_id_requires_the_actual_launch_argument']) assert.ok(patch.includes(text),text);
  assert.doesNotMatch(patch, /^\+.*(?:GetSecret|SearchItems|CreateCollection|SetSecret|ensure_device_credentials\(|https:\/\/)/m);
  const build = await fs.readFile('scripts/build-backend.mjs', 'utf8');
  assert.ok(build.includes("'keyring_unlock_', '--', '--test-threads=1'"));
  assert.ok((await fs.readFile('.github/workflows/backend.yml','utf8')).includes('dbus-daemon'));
});

test('session keyring shutdown is limited to its verified Nexus-owned provider and has no credential API', async () => {
  const lock = JSON.parse(await fs.readFile('assets/backend-source.lock.json', 'utf8'));
  assert.ok(lock.patches.some(p => p.file === 'xodus-keyring-session-stop.patch'));
  const patch = await fs.readFile('assets/xodus-keyring-session-stop.patch', 'utf8');
  for (const text of ['KeyringSessionStop', 'GetConnectionUnixProcessID', 'GetConnectionUnixUser',
    'xodus-nexus-keyring-', '/MainApplication', 'org.qtproject.Qt.QCoreApplication',
    'keyring_session_stop_private_bus_never_quits_a_replacement_owner',
    'keyring_session_stop_private_bus_rejects_foreign_pid_uid_and_cgroup',
    'keyring_session_stop_private_bus_bounds_unresponsive_and_nonexiting_providers',
    'keyring_session_stop_rejects_unmanaged_process_before_connecting_to_user_bus']) assert.ok(patch.includes(text), text);
  assert.doesNotMatch(patch, /^\+.*(?:GetSecret|SearchItems|CreateCollection|SetSecret|closeAllWallets|ensure_device_credentials\(|https:\/\/)/m);
  const build = await fs.readFile('scripts/build-backend.mjs', 'utf8');
  assert.ok(build.includes("'keyring_session_', '--', '--test-threads=1'"));
  assert.ok(build.includes("'keyring-session-stop'"));
});

test('optional KWallet persistence uses own watched session without locking or stopping other providers', async () => {
  const lock=JSON.parse(await fs.readFile('assets/backend-source.lock.json','utf8'));
  assert.ok(lock.patches.some(p=>p.file==='xodus-keyring-persistence.patch'));
  const patch=await fs.readFile('assets/xodus-keyring-persistence.patch','utf8');
  for(const name of ['genuine_ksecret','prompt_is_disabled','openAsync','message.set_no_reply(true)',
    'keyring_persistence_private_bus_foreign_and_absent_provider_are_untouched',
    'keyring_persistence_private_bus_no_creation_unlock_or_extra_authorization',
    'keyring_persistence_private_bus_replacement_or_lock_race_releases_only_own_handle',
    'keyring_persistence_private_bus_timeout_denial_and_foreign_signal_never_sync']) assert.ok(patch.includes(name),name);
  assert.doesNotMatch(patch,/^\+.*(?:"GetSecret"|"SearchItems"|"Unlock"|"Lock"|"quit"|"CreateCollection"|"pamOpen"|closeAllWallets|FDO_APPID)/m);
  const build=await fs.readFile('scripts/build-backend.mjs','utf8');
  assert.ok(build.includes("'keyring_persistence_', '--', '--test-threads=1'"));
});

test('backend workflow shell parses and resolves the locked toolchain', async () => {
  const require = createRequire(import.meta.url);
  const yaml = require('js-yaml');
  const workflow = yaml.load(await fs.readFile('.github/workflows/backend.yml', 'utf8'));
  const steps = workflow.jobs.build.steps;
  for (const step of steps) if (step.run) execFileSync('bash', ['-n', '-c', step.run], { stdio: 'pipe' });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'backend-workflow-test-'));
  try {
    const env = path.join(root, 'env');
    execFileSync('bash', ['-c', steps.find(step => step.name === 'Read pinned Rust version').run], { env: { ...process.env, GITHUB_ENV: env } });
    const lock = JSON.parse(await fs.readFile('assets/backend-source.lock.json', 'utf8'));
    assert.equal(await fs.readFile(env, 'utf8'), `BACKEND_RUST=${lock.rust}\n`);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('backend build runs account-free credential persistence regressions', async () => {
  const build = await fs.readFile('scripts/build-backend.mjs', 'utf8');
  assert.match(build, /command\('cargo', \['test', '--locked', \.\.\.offline, \.\.\.features, '-p', 'xodus', 'credential_'\]\)/);
  const lock = JSON.parse(await fs.readFile('assets/backend-source.lock.json', 'utf8'));
  assert.ok(lock.patches.some(patch => patch.file === 'xodus-keyring-credentials.patch'));
  assert.ok(lock.patches.some(patch => patch.file === 'xodus-keyring-encoding.patch'));
  assert.ok(lock.patches.findIndex(p => p.file === 'xodus-auth-consistency.patch') <
    lock.patches.findIndex(p => p.file === 'xodus-keyring-encoding.patch'));
});

test('authenticated account metadata remains bound, additive and covered by backend regressions', async () => {
  const lock = JSON.parse(await fs.readFile('assets/backend-source.lock.json', 'utf8'));
  const metadata=lock.patches.findIndex(p=>p.file==='xodus-authenticated-account-metadata.patch');
  assert.ok(metadata>lock.patches.findIndex(p=>p.file==='xodus-content-device-limit.patch'));
  assert.equal(lock.patches[metadata+1].file,'xodus-social.patch');
  const patch = await fs.readFile('assets/xodus-authenticated-account-metadata.patch', 'utf8');
  for (const expected of ['get_user_sts_session', 'self.user_session()?', 'bound_ids',
    'credential_account_metadata_snapshot_is_atomic_and_logout_removes_it',
    'credential_account_metadata_never_pairs_different_sessions_under_concurrent_reads',
    'account_metadata_uses_real_session_ids_and_rejects_mixed_accounts',
    'account_metadata_rejects_placeholder_malformed_and_empty_ids',
    'account_metadata_xml_is_additive_and_omitted_for_unbound_sessions',
    'skip_serializing_if = "Option::is_none"']) assert.ok(patch.includes(expected), expected);
  assert.doesNotMatch(patch, /diff --git a\/.*(?:login\.rs|license\.rs|streaming\.rs|run\.rs)/);
  assert.doesNotMatch(patch, /^\+.*(?:println!|tracing::).*puid/m);
  const build = await fs.readFile('scripts/build-backend.mjs', 'utf8');
  assert.ok(build.includes("'-p', 'xodus-service', 'account_metadata_'"));
});

test('GNOME textual keyring regression uses only in-memory synthetic data', { skip: process.platform !== 'linux' }, () => {
  execFileSync('python3', ['scripts/keyring-textual-roundtrip.test.py'], { stdio: 'pipe' });
});

test('session recovery is pinned and does not replace interactive login or raw token reads', async () => {
  const lock = JSON.parse(await fs.readFile('assets/backend-source.lock.json', 'utf8'));
  assert.ok(lock.patches.some(patch => patch.file === 'xodus-session-recovery.patch'));
  const patch = await fs.readFile('assets/xodus-session-recovery.patch', 'utf8');
  for (const expected of ['session-user-expired', 'ticket-timeout', 'refresh_existing_device_credentials', 'try_lock_exclusive',
    'credential_session_valid_signin_has_no_renewal', 'ticket_real_transport_timeout_and_http_refusal_classification']) assert.ok(patch.includes(expected));
  assert.doesNotMatch(patch, /diff --git a\/.*(?:login\.rs|tokens\/manager\.rs|webview_stdio\.rs)/);
});

test('delegation-compact store tickets are converted only for Store and licensing requests', async () => {
  const lock = JSON.parse(await fs.readFile('assets/backend-source.lock.json', 'utf8'));
  assert.ok(lock.patches.some(patch => patch.file === 'xodus-store-ticket.patch'));
  const patch = await fs.readFile('assets/xodus-store-ticket.patch', 'utf8');
  for (const expected of ['pub fn store_ticket', 'store_ticket_accepts_compact_and_delegation_compact_forms',
    'store_license_accepts_delegation_compact_user_tickets']) assert.ok(patch.includes(expected), expected);
  assert.doesNotMatch(patch, /diff --git a\/.*(?:tokens\/|login\.rs)/);
  assert.doesNotMatch(patch, /^-.*"d=\{\}"/m);
  assert.ok(patch.includes('Token::try_from(response).map_err(|_| FAIL)?'));
  assert.ok(lock.patches.findIndex(p => p.file === 'xodus-auth-consistency.patch') <
    lock.patches.findIndex(p => p.file === 'xodus-store-ticket.patch'));
});

test('content-license parsing is pinned, regression-tested and does not change authentication or streaming', async () => {
  const lock = JSON.parse(await fs.readFile('assets/backend-source.lock.json', 'utf8'));
  assert.ok(lock.patches.some(patch => patch.file === 'xodus-content-response.patch'));
  const patch = await fs.readFile('assets/xodus-content-response.patch', 'utf8');
  for (const expected of ['content-license request', 'content_license_request_contract_is_unchanged',
    'content_license_success_preserves_existing_first_key', 'content_license_status_precedes_body',
    'content_license_malformed_keys_are_errors_not_panics', 'NEXUS_CONTENT_LICENSE_DIAGNOSTIC_V1']) assert.ok(patch.includes(expected), expected);
  assert.doesNotMatch(patch, /diff --git a\/.*(?:tokens\/|login\.rs|streaming\.rs|package_plan\.rs)/);
  const build = await fs.readFile('scripts/build-backend.mjs', 'utf8');
  assert.match(build, /command\('cargo', \['test', '--locked', \.\.\.offline, \.\.\.features, '-p', 'xodus', 'content_license_'\]\)/);
});

test('streaming recovery keeps verified ranges and checkpoints without touching authentication', async () => {
  const lock = JSON.parse(await fs.readFile('assets/backend-source.lock.json', 'utf8'));
  assert.ok(lock.patches.some(patch => patch.file === 'xodus-streaming-recovery.patch'));
  const patch = await fs.readFile('assets/xodus-streaming-recovery.patch', 'utf8');
  for (const text of ['NEXUS_TRANSFER_DIAGNOSTIC_V1', 'transfer-http', 'transfer-range',
    'streaming_resume_terminal_http_error_checkpoints_only_written_pages_then_restarts_exactly',
    'streaming_http_production_timeout_tolerates_a_six_second_slow_response',
    'streaming_failure_cancels_and_settles_parallel_workers_without_completing_failed_jobs',
    'streaming_failure_preserves_existing_game_and_dlc_files_and_completed_marker']) assert.ok(patch.includes(text), text);
  assert.doesNotMatch(patch, /diff --git a\/.*(?:tokens\/|licensing\/|license\.rs|login\.rs|package_plan\.rs)/);
  const build = await fs.readFile('scripts/build-backend.mjs', 'utf8');
  assert.match(build, /command\('cargo', \['test', '--locked', \.\.\.offline, \.\.\.features, '-p', 'msixvc', 'streaming_'\]\)/);
});

test('corresponding-source archive preserves nested target source directories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'backend-source-archive-'));
  try {
    const entries = ['source/.git/config', 'source/target/debug/binary', 'source/vendor/cc/src/target/apple.rs',
      'source/vendor/dependency/.git/reference', 'source/vendor/other/source/target/parser.rs',
      'source/vendor/other/source/.git/reference', 'source/crates/xodus/src/lib.rs', 'recipe/scripts/build-backend.mjs'];
    for (const name of entries) {
      await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await fs.writeFile(path.join(root, name), 'synthetic source');
    }
    const archive = path.join(root, 'source.tar.xz');
    execFileSync('tar', backendSourceArchiveArgs(archive, root));
    const listing = execFileSync('tar', ['-tJf', archive], { encoding: 'utf8' }).split('\n');
    for (const name of entries.slice(2)) assert.ok(listing.includes(name), `Missing ${name}`);
    for (const name of entries.slice(0, 2)) assert.ok(!listing.includes(name), `Unexpected ${name}`);
    const build = await fs.readFile('scripts/build-backend.mjs', 'utf8');
    assert.match(build, /command\('tar', backendSourceArchiveArgs\(/);
    assert.match(build, /copyFile\(path.join\(root, 'scripts\/backend-source-archive.mjs'\)/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('Durable package selection is opt-in, parent-bound and preserves legacy automatic game downloads',async()=>{
  const lock=JSON.parse(await fs.readFile('assets/backend-source.lock.json','utf8'));
  const entry=lock.patches.find(p=>p.file==='xodus-durable-content.patch');assert.ok(entry);
  const patch=await fs.readFile('assets/'+entry.file,'utf8');assert.equal(createHash('sha256').update(patch).digest('hex'),entry.sha256);
  for(const expected of ['include_dlc: bool','without_durable_selection','parentProductId','mainPackageFamilyName',
    'durable_pc_package_requires_explicit_selection_and_verified_parent_metadata',
    'durable_missing_foreign_or_ambiguous_parent_and_non_pc_formats_stay_unsupported'])assert.ok(patch.includes(expected),expected);
  const files=[...patch.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map(match=>match[1]).sort();
  assert.deepEqual(files,['crates/xodus-cli/src/commands/streaming.rs','crates/xodus-cli/src/main.rs','crates/xodus-cli/src/package_plan.rs']);
  assert.doesNotMatch(patch,/^[+-].*(?:ensure_device|init_secrets|\.get_packages|\.get_license|\.save_|\.remove_)/m);
  const main=await fs.readFile('src/main/index.ts','utf8');
  assert.ok(main.includes('contentParentForChoice(choice, store.games)'));assert.ok(main.includes("if (updateGame && choice.kind === 'Durable')"));
  const build=await fs.readFile('scripts/build-backend.mjs','utf8');assert.ok(build.includes("['resolve-package', '--help']"));
});

test('conditional entitlement provenance is typed without changing account, download or launch code', async () => {
  const lock = JSON.parse(await fs.readFile('assets/backend-source.lock.json', 'utf8'));
  const entry = lock.patches.find(patch => patch.file === 'xodus-conditional-entitlements.patch');
  assert.ok(entry);
  const patch = await fs.readFile('assets/' + entry.file, 'utf8');
  assert.equal(createHash('sha256').update(patch).digest('hex'), entry.sha256);
  const files = [...patch.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map(match => match[1]);
  assert.deepEqual(files, ['crates/xodus-cli/src/commands/library.rs']);
  for (const expected of ['and_then(Value::as_bool) == Some(true)', '"isPositron":positron',
    'positron_provenance_is_explicit_boolean_and_never_copied_from_untrusted_fields',
    'conflicting_positron_and_unknown_special_rows_quarantine_their_children', 'positron_normalized_protocol_fixture'])
    assert.ok(patch.includes(expected), expected);
  assert.doesNotMatch(patch, /^[+-].*(?:store_session|\.get_user|\.get_license|Authorization|\.send\(|\.save_|\.remove_)/m);
});

test('Store device-limit guidance is a bounded response-only change with the official management URL', async () => {
  const lock = JSON.parse(await fs.readFile('assets/backend-source.lock.json', 'utf8'));
  const entry = lock.patches.find(patch => patch.file === 'xodus-content-device-limit.patch');
  assert.ok(entry);
  const patch = await fs.readFile('assets/' + entry.file, 'utf8');
  assert.equal(createHash('sha256').update(patch).digest('hex'), entry.sha256);
  assert.deepEqual([...patch.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map(match => match[1]), [
    'crates/xodus/src/licensing/content_response.rs', 'crates/xodus/src/licensing/content_response_tests.rs',
  ]);
  for (const text of ['satisfaction_failure.code == 501', 'content-device-limit',
    'https://account.microsoft.com/devices/content', 'content_license_device_limit_http_is_not_an_http501_and_never_retries'])
    assert.ok(patch.includes(text), text);
  assert.doesNotMatch(patch, /^[+-].*(?:\.send\(|\.post\(|Authorization|\.save_|\.remove_|ensure_device|init_secrets)/m);
});

test('outgoing chat reuses the current login identity with server-issued context and exact request signatures',async()=>{
  const lock=JSON.parse(await fs.readFile('assets/backend-source.lock.json','utf8'));
  const entry=lock.patches.find(value=>value.file==='xodus-social-session.patch');assert.ok(entry);
  const patch=await fs.readFile('assets/'+entry.file,'utf8');
  assert.equal(createHash('sha256').update(patch).digest('hex'),entry.sha256);
  assert.ok(lock.patches.findIndex(value=>value.file===entry.file)>lock.patches.findIndex(value=>value.file==='xodus-social-send-receipt.patch'));
  const sections=patch.split(/(?=^diff --git )/m).filter(Boolean);
  assert.deepEqual([...patch.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map(value=>value[1]).sort(),[
    'crates/xodus-cli/src/commands/login.rs','crates/xodus-cli/src/commands/social.rs','crates/xodus-cli/src/commands/social_session.rs',
  ]);
  const login=sections.find(value=>value.includes(' b/crates/xodus-cli/src/commands/login.rs\n'));
  const changes=login.split('\n').filter(value=>/^[+-]/.test(value)&&!/^\+\+\+|^---/.test(value));
  assert.equal(changes.length,2);assert.equal(changes[1].replace('+pub(super) ','-'),changes[0]);
  const session=sections.find(value=>value.includes(' b/crates/xodus-cli/src/commands/social_session.rs\n'));
  const production=session.split('+#[cfg(test)]')[0];
  for(const name of ['chat_session_signature_preserves_exact_bytes_and_rejects_tampering',
    'chat_session_issued_tickets_keep_the_server_type_and_require_fresh_lifetimes',
    'chat_session_xsts_requires_one_real_user_communications_and_unexpired_token',
    'chat_session_writes_require_atomic_identity_and_reject_same_name_different_principal',
    'chat_session_post_is_signed_once_without_retries_redirects_or_error_payloads'])assert.ok(session.includes(name),name);
  for(const value of ['super::super::login::CLIENT_ID','get_user_sts_session()',
    'find_relying_party_for_url(super::MESSAGES)','signer.sign_request(legacy, None)',
    'signer.verify(signed)','"ProofKey":signer.get_proof_key()',
    '"TitleToken":title_token','"DeviceToken":device_token','"UserTokens":[user_token]',
    '"CommunicateUsingText"','value["isAllowed"] != true','super::payload(&op, &value)?'])assert.ok(production.includes(value),value);
  assert.doesNotMatch(production,/\.save_|ensure_device_credentials|start_new_session|do_sisu\(|danger_accept|readHorizon|mark.read|\.delete\(|\/tmp\/|NEXUS_CHAT_(?:DIAG|BOUND)/i);
  assert.ok(sections.find(value=>value.includes(' b/crates/xodus-cli/src/commands/social.rs\n')).includes('chat_session::send(tokens, peer, message)'));
});

test('installation estimates are public metadata only and never replace actual download space checks (#247)', async () => {
  const lock=JSON.parse(await fs.readFile('assets/backend-source.lock.json','utf8'));
  const entry=lock.patches.find(value=>value.file==='xodus-package-storage.patch');assert.ok(entry);
  const patch=await fs.readFile('assets/'+entry.file,'utf8');
  assert.equal(createHash('sha256').update(patch).digest('hex'),entry.sha256);
  assert.deepEqual([...patch.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map(value=>value[1]),['crates/xodus-cli/src/package_plan.rs']);
  for(const name of ['MaxDownloadSizeInBytes','MaxInstallSizeInBytes','9_007_199_254_740_991',
    'package_storage_estimates_are_optional_positive_and_bound_to_the_selected_content',
    'package_storage_estimates_merge_retail_duplicates_without_using_trial_or_foreign_sizes'])assert.ok(patch.includes(name),name);
  const added=patch.split('\n').filter(line=>line.startsWith('+')&&!line.startsWith('+++')).join('\n');
  assert.doesNotMatch(added,/get_license|tokens\.|Authorization|\.send\(|\.save_|\.remove_|required_free_space|available_free_space/);
  const storage=await fs.readFile('src/main/install-storage.ts','utf8');
  assert.ok(storage.includes('fs.statfs(current, { bigint: true })'));
  assert.doesNotMatch(storage,/\.mkdir\(|\.writeFile\(|\.rm\(|\.unlink\(/);
});

test('chat JSON output remains strict and uses quiet equivalent policy selection without changing identity or sending', async () => {
  const lock=JSON.parse(await fs.readFile('assets/backend-source.lock.json','utf8'));
  const entry=lock.patches.find(value=>value.file==='xodus-social-stdout.patch');assert.ok(entry);
  const patch=await fs.readFile('assets/'+entry.file,'utf8');
  assert.equal(createHash('sha256').update(patch).digest('hex'),entry.sha256);
  assert.ok(lock.patches.findIndex(value=>value.file===entry.file)>lock.patches.findIndex(value=>value.file==='xodus-social-session.patch'));
  assert.deepEqual([...patch.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map(value=>value[1]),['crates/xodus-cli/src/commands/social_session.rs']);
  const production=patch.split('chat_session_policy_lookup_keeps_stdout_machine_readable')[0];
  for(const name of ['cache.get_endpoints()','endpoint.protocol.eq_ignore_ascii_case','host.eq_ignore_ascii_case',
    'host.ends_with(endpoint.host.trim_start_matches','url.path() == path','max_by_key','endpoint.relying_party.clone()'])assert.ok(production.includes(name),name);
  for(const name of ['chat_session_policy_lookup_keeps_stdout_machine_readable',
    'chat_session_quiet_audience_matches_pinned_policy_selection_without_fallback'])assert.ok(patch.includes(name),name);
  const added=production.split('\n').filter(line=>line.startsWith('+')&&!line.startsWith('+++')).join('\n');
  assert.doesNotMatch(added,/println!|\.post\(|\.send\(|\.save_|ensure_device_credentials|\.header\(|\.json\(/);
  assert.ok((await fs.readFile('src/main/xbox-social.ts','utf8')).includes('JSON.parse(output)'));
});
