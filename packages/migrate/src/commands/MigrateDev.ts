import {
  arg,
  Command,
  format,
  HelpError,
  isError,
  getSchemaPath,
  getCommandWithExecutor,
  isCi,
  logger,
  getConfig,
  getDMMF,
} from '@prisma/sdk'
import Debug from '@prisma/debug'
import chalk from 'chalk'
import prompt from 'prompts'
import fs from 'fs'
import path from 'path'
import { Migrate } from '../Migrate'
import {
  ensureDatabaseExists,
  getDbInfo,
  DbType,
} from '../utils/ensureDatabaseExists'
import {
  ExperimentalFlagWithNewMigrateError,
  EarlyAccessFeatureFlagWithNewMigrateError,
} from '../utils/flagErrors'
import {
  NoSchemaFoundError,
  MigrateDevEnvNonInteractiveError,
} from '../utils/errors'
import { printMigrationId } from '../utils/printMigrationId'
import { printFilesFromMigrationIds } from '../utils/printFiles'
import { handleUnexecutableSteps } from '../utils/handleEvaluateDataloss'
import { getMigrationName } from '../utils/promptForMigrationName'
import { throwUpgradeErrorIfOldMigrate } from '../utils/detectOldMigrate'
import { printDatasource } from '../utils/printDatasource'
import {
  executeSeedCommand,
  verifySeedConfigAndReturnMessage,
  getSeedCommandFromPackageJson,
} from '../utils/seed'
import { EngineResults } from '../types'

const debug = Debug('prisma:migrate:dev')

export class MigrateDev implements Command {
  public static new(): MigrateDev {
    return new MigrateDev()
  }

  private static help = format(`
${
  process.platform === 'win32' ? '' : chalk.bold('🏋️  ')
}Create a migration from changes in Prisma schema, apply it to the database, trigger generators (e.g. Prisma Client)
 
${chalk.bold('Usage')}

  ${chalk.dim('$')} prisma migrate dev [options]

${chalk.bold('Options')}

       -h, --help   Display this help message
         --schema   Custom path to your Prisma schema
       -n, --name   Name the migration
    --create-only   Create a new migration but do not apply it
                    The migration will be empty if there are no changes in Prisma schema
  --skip-generate   Skip triggering generators (e.g. Prisma Client)
      --skip-seed   Skip triggering seed

${chalk.bold('Examples')}

  Create a migration from changes in Prisma schema, apply it to the database, trigger generators (e.g. Prisma Client)
  ${chalk.dim('$')} prisma migrate dev

  Specify a schema
  ${chalk.dim('$')} prisma migrate dev --schema=./schema.prisma

  Create a migration without applying it
  ${chalk.dim('$')} prisma migrate dev --create-only
  `)

  public async parse(argv: string[]): Promise<string | Error> {
    const args = arg(argv, {
      '--help': Boolean,
      '-h': '--help',
      '--name': String,
      '-n': '--name',
      // '--force': Boolean,
      // '-f': '--force',
      '--create-only': Boolean,
      '--schema': String,
      '--skip-generate': Boolean,
      '--skip-seed': Boolean,
      '--experimental': Boolean,
      '--early-access-feature': Boolean,
      '--telemetry-information': String,
    })

    if (isError(args)) {
      return this.help(args.message)
    }

    if (args['--help']) {
      return this.help()
    }

    if (args['--experimental']) {
      throw new ExperimentalFlagWithNewMigrateError()
    }

    if (args['--early-access-feature']) {
      throw new EarlyAccessFeatureFlagWithNewMigrateError()
    }

    const schemaPath = await getSchemaPath(args['--schema'])

    if (!schemaPath) {
      throw new NoSchemaFoundError()
    }

    console.info(
      chalk.dim(
        `Prisma schema loaded from ${path.relative(process.cwd(), schemaPath)}`,
      ),
    )

    await printDatasource(schemaPath)

    console.info() // empty line

    throwUpgradeErrorIfOldMigrate(schemaPath)

    // Validate schema (same as prisma validate)
    const schema = fs.readFileSync(schemaPath, 'utf-8')
    await getDMMF({
      datamodel: schema,
    })
    await getConfig({
      datamodel: schema,
    })

    // Automatically create the database if it doesn't exist
    const wasDbCreated = await ensureDatabaseExists('create', true, schemaPath)
    if (wasDbCreated) {
      console.info(wasDbCreated)
      console.info() // empty line
    }

    const migrate = new Migrate(schemaPath)

    let devDiagnostic: EngineResults.DevDiagnosticOutput
    try {
      devDiagnostic = await migrate.devDiagnostic()
      debug({ devDiagnostic: JSON.stringify(devDiagnostic, null, 2) })
    } catch (e) {
      migrate.stop()
      throw e
    }

    const migrationIdsApplied: string[] = []

    if (devDiagnostic.action.tag === 'reset') {
      if (!args['--force']) {
        // We use prompts.inject() for testing in our CI
        if (isCi() && Boolean((prompt as any)._injected?.length) === false) {
          migrate.stop()
          throw new MigrateDevEnvNonInteractiveError()
        }

        const dbInfo = await getDbInfo(schemaPath)
        const confirmedReset = await this.confirmReset(
          dbInfo,
          devDiagnostic.action.reason,
        )

        if (!confirmedReset) {
          console.info() // empty line
          console.info('Reset cancelled.')
          migrate.stop()
          process.exit(0)
          // For snapshot test, because exit() is mocked
          return ``
        }
      }

      try {
        // Do the reset
        await migrate.reset()
      } catch (e) {
        migrate.stop()
        throw e
      }
    }

    try {
      const { appliedMigrationNames } = await migrate.applyMigrations()
      migrationIdsApplied.push(...appliedMigrationNames)

      // Inform user about applied migrations now
      if (appliedMigrationNames.length > 0) {
        console.info(
          `The following migration(s) have been applied:\n\n${chalk(
            printFilesFromMigrationIds('migrations', appliedMigrationNames, {
              'migration.sql': '',
            }),
          )}`,
        )
      }
    } catch (e) {
      migrate.stop()
      throw e
    }

    // If database was reset we want to run the seed if not skipped
    if (
      devDiagnostic.action.tag === 'reset' &&
      !process.env.PRISMA_MIGRATE_SKIP_SEED &&
      !args['--skip-seed']
    ) {
      // Run seed if 1 or more seed files are present
      // And catch the error to continue execution
      try {
        const seedCommandFromPkgJson = await getSeedCommandFromPackageJson(
          process.cwd(),
        )

        if (seedCommandFromPkgJson) {
          console.info() // empty line
          const successfulSeeding = await executeSeedCommand(
            seedCommandFromPkgJson,
          )
          if (successfulSeeding) {
            console.info(
              `\n${
                process.platform === 'win32' ? '' : '🌱  '
              }The seed command has been executed.\n`,
            )
          } else {
            console.info() // empty line
          }
        } else {
          // Only used to help users to setup their seeds from old way to new package.json config
          const schemaPath = await getSchemaPath(args['--schema'])

          const message = await verifySeedConfigAndReturnMessage(schemaPath)
          // warn because setup of the feature needs to be done
          if (message) {
            console.warn() // empty line
            logger.warn(message)
            console.warn() // empty line
          }
        }
      } catch (e) {
        console.error(e)
      }
    }

    let evaluateDataLossResult: EngineResults.EvaluateDataLossOutput
    try {
      evaluateDataLossResult = await migrate.evaluateDataLoss()
      debug({ evaluateDataLossResult })
    } catch (e) {
      migrate.stop()
      throw e
    }

    // display unexecutableSteps
    // throws error if not create-only
    const unexecutableStepsError = handleUnexecutableSteps(
      evaluateDataLossResult.unexecutableSteps,
      args['--create-only'],
    )
    if (unexecutableStepsError) {
      migrate.stop()
      throw new Error(unexecutableStepsError)
    }

    // log warnings and prompt user to continue if needed
    if (
      evaluateDataLossResult.warnings &&
      evaluateDataLossResult.warnings.length > 0
    ) {
      console.log(chalk.bold(`\n⚠️  Warnings for the current datasource:\n`))
      for (const warning of evaluateDataLossResult.warnings) {
        console.log(chalk(`  • ${warning.message}`))
      }
      console.info() // empty line

      if (!args['--force']) {
        // We use prompts.inject() for testing in our CI
        if (isCi() && Boolean((prompt as any)._injected?.length) === false) {
          migrate.stop()
          throw new MigrateDevEnvNonInteractiveError()
        }

        const message = args['--create-only']
          ? 'Are you sure you want create this migration?'
          : 'Are you sure you want create and apply this migration?'
        const confirmation = await prompt({
          type: 'confirm',
          name: 'value',
          message,
        })

        if (!confirmation.value) {
          migrate.stop()
          return `Migration cancelled.`
        }
      }
    }

    let migrationName: undefined | string = undefined
    if (evaluateDataLossResult.migrationSteps > 0 || args['--create-only']) {
      const getMigrationNameResult = await getMigrationName(args['--name'])

      if (getMigrationNameResult.userCancelled) {
        migrate.stop()
        return getMigrationNameResult.userCancelled
      } else {
        migrationName = getMigrationNameResult.name
      }
    }

    let migrationIds: string[]
    try {
      const createMigrationResult = await migrate.createMigration({
        migrationsDirectoryPath: migrate.migrationsDirectoryPath,
        migrationName: migrationName || '',
        draft: args['--create-only'] ? true : false,
        prismaSchema: migrate.getDatamodel(),
      })
      debug({ createMigrationResult })

      if (args['--create-only']) {
        migrate.stop()

        return `Prisma Migrate created the following migration without applying it ${printMigrationId(
          createMigrationResult.generatedMigrationName!,
        )}\n\nYou can now edit it and apply it by running ${chalk.greenBright(
          getCommandWithExecutor('prisma migrate dev'),
        )}.`
      }

      const { appliedMigrationNames } = await migrate.applyMigrations()
      migrationIds = appliedMigrationNames
    } finally {
      migrate.stop()
    }

    // For display only, empty line
    migrationIdsApplied.length > 0 && console.info()

    if (migrationIds.length === 0) {
      if (migrationIdsApplied.length > 0) {
        console.info(
          `${chalk.green('Your database is now in sync with your schema.')}`,
        )
      } else {
        console.info(
          `Already in sync, no schema change or pending migration was found.`,
        )
      }
    } else {
      console.info(
        `The following migration(s) have been created and applied from new schema changes:\n\n${chalk(
          printFilesFromMigrationIds('migrations', migrationIds, {
            'migration.sql': '',
          }),
        )}

${chalk.green('Your database is now in sync with your schema.')}`,
      )
    }

    // Run if not skipped
    if (!process.env.PRISMA_MIGRATE_SKIP_GENERATE && !args['--skip-generate']) {
      await migrate.tryToRunGenerate()
      console.info() // empty line
    }

    return ''
  }

  private async confirmReset(
    {
      schemaWord,
      dbType,
      dbName,
      dbLocation,
    }: {
      schemaWord?: 'database'
      dbType?: DbType
      dbName?: string
      dbLocation?: string
    },
    reason: string,
  ): Promise<boolean> {
    const mssqlMessage = `${reason}

We need to reset the database.
Do you want to continue? ${chalk.red('All data will be lost')}.`

    const message = `${reason}

We need to reset the ${dbType} ${schemaWord} "${dbName}" at "${dbLocation}".
Do you want to continue? ${chalk.red('All data will be lost')}.`

    const confirmation = await prompt({
      type: 'confirm',
      name: 'value',
      message: dbType === 'SQL Server' ? mssqlMessage : message,
    })

    return confirmation.value
  }

  public help(error?: string): string | HelpError {
    if (error) {
      return new HelpError(
        `\n${chalk.bold.red(`!`)} ${error}\n${MigrateDev.help}`,
      )
    }
    return MigrateDev.help
  }
}
