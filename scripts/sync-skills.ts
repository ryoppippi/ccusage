import { lstat, mkdir, readdir, readlink, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

const ROOT = new URL('..', import.meta.url).pathname;
const checkMode = process.argv.includes('--check');

let hasErrors = false;

const AGENTS_SKILLS = join(ROOT, '.agents', 'skills');
const SKILL_TARGETS = [{ dir: join(ROOT, '.claude', 'skills'), label: '.claude/skills' }];

const agentSkillDirs = await readdir(AGENTS_SKILLS);

const expectedTarget = (name: string) => `../../.agents/skills/${name}`;

for (const { dir, label } of SKILL_TARGETS) {
	if (!checkMode) {
		await mkdir(dir, { recursive: true });
	}
	const entries = await readdir(dir).catch(() => [] as string[]);

	const linkedSkills = await Promise.all(
		agentSkillDirs.map(async (name) => {
			const s = await lstat(join(AGENTS_SKILLS, name));
			if (!s.isDirectory()) {
				return null;
			}

			const dst = join(dir, name);

			if (checkMode) {
				try {
					const existing = await lstat(dst);
					if (!existing.isSymbolicLink()) {
						console.error(`❌ Skill not a symlink: ${label}/${name}`);
						hasErrors = true;
						return null;
					}
					const target = await readlink(dst);
					if (target !== expectedTarget(name)) {
						console.error(`❌ Skill symlink incorrect: ${label}/${name}`);
						hasErrors = true;
						return null;
					}
					return name;
				} catch {
					console.error(`❌ Skill missing: ${label}/${name}`);
					hasErrors = true;
					return null;
				}
			} else {
				try {
					const existing = await lstat(dst);
					if (existing.isSymbolicLink()) {
						const target = await readlink(dst);
						if (target === expectedTarget(name)) {
							return name;
						}
					}
					await rm(dst, { recursive: true, force: true });
				} catch {
					// doesn't exist
				}

				await symlink(expectedTarget(name), dst);
				return name;
			}
		}),
	);

	const validSkills = linkedSkills.filter((n): n is string => n !== null);
	const expectedSkillNames = new Set(validSkills);
	const skillOrphans = entries.filter((name) => !expectedSkillNames.has(name));

	if (!checkMode) {
		await Promise.all(
			skillOrphans.map(async (name) => {
				await rm(join(dir, name), { recursive: true, force: true });
				console.log(`Removed orphan skill: ${label}/${name}`);
			}),
		);
	}

	if (skillOrphans.length > 0 && checkMode) {
		skillOrphans.forEach((name) => {
			console.error(`❌ Orphan skill: ${label}/${name}`);
		});
		hasErrors = true;
	}

	if (!checkMode) {
		console.log(`Synced ${validSkills.length} skills: .agents/skills/ -> ${label}/ (symlinks)`);
	}
}

if (checkMode && hasErrors) {
	console.error('\n❌ Skills are not in sync!');
	console.error('Run: bun scripts/sync-skills.ts');
	process.exit(1);
} else if (checkMode) {
	console.log('✅ Skills are in sync!');
}
