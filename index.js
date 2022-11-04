// Import the necessary dependencies
const core = require('@actions/core')
const github = require('@actions/github')
const ipInfo = require('ipinfo')
const azureRegions = require('./data/azure-regions.json')
const os = require('node:os')
const axios = require('axios').default

async function run() {
	// Get action input parameters
	const token = core.getInput('token')
	const delayTolerance = parseInt(core.getInput('delay-tolerance'))
	const baseUrlCarbonApi = core.getInput('base-url-carbon-aware-api')
  const ENV_NAME = core.getInput('environment-name')

	// Instantiate octokit client
	const octokit = github.getOctokit(token)

	// Determine OS of runner
	const RUNNER_PLATFORM = os.platform()
	const RUNNER_OS = await _getRunnerOs(RUNNER_PLATFORM)

	core.info(`Runner OS: ${RUNNER_OS}`)

	// Get IP info of the runner machine
	const IP_INFO = await _getIPInfo()

	core.info(`Runner IP: ${IP_INFO.ip}`)
	core.info(`Runner IP location: ${IP_INFO.region}`)

	// Get Azure region corresponding to runner location
	const RUNNER_LOCATION = await _getRunnerLocation(IP_INFO.region)

	core.info(`Matching Azure region: ${RUNNER_LOCATION}`)

	// Get current emission level at runner location
	const CURRENT_EMISSION_RATING = await _getCurrentEmissionLevel(baseUrlCarbonApi, RUNNER_LOCATION)

	core.info(`Current emission rating in region ${RUNNER_LOCATION}: ${CURRENT_EMISSION_RATING.rating}`)

  // Get context of the current workflow run
	const workflowRun = await octokit.rest.actions.getWorkflowRun({
		owner: github.context.repo.owner,
		repo: github.context.repo.repo,
		run_id: github.context.runId,
	})

  // We only want to run the job if it hasn't already been delayed once (the current implementation is a "one-off" delay, to avoid infinite loops)
	// We decide whether the current job has already been delayed by looking at the amount of run attempts for this workflow's run ID. 
  // TODO - this logic should be improved, we cannot be sure that the previous run attempt was triggered by this action, it could also be user-triggered
	if (workflowRun.data.run_attempt > 1) {
		core.info('This job has already been delayed once, the workflow will continue without taking further action.')

    // Delete the environment created in previous run
    core.info(`Deleting environment ${ENV_NAME}in preparation for next run`)
    await octokit.rest.repos.deleteAnEnvironment({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      environment_name: ENV_NAME
    })
		return
	} else {
		// Get forecasted emission level at runner location
		// We don't want to print everything to console by default, to reduce noise. Rather print it to debug log.
		const FORECASTED_EMISSION_RATINGS = await _getForecastedEmissionLevels(baseUrlCarbonApi, RUNNER_LOCATION)

		core.info(`Successfully fetched forecasted emission ratings in region ${RUNNER_LOCATION}`)
		core.debug(`Forecasted emission ratings in region ${RUNNER_LOCATION}: ${JSON.stringify(FORECASTED_EMISSION_RATINGS)}`)

		// Get all forecasted emission ratings within the tolerance window (in minutes)
		core.info(`Delay tolerance: ${delayTolerance} minutes`)

		const FORECASTED_EMISSION_RATINGS_WITHIN_TOLERANCE = await _getForecastWithinDelayTolerance(
			FORECASTED_EMISSION_RATINGS[0].forecastData,
			delayTolerance
		)

		core.info(`Found ${FORECASTED_EMISSION_RATINGS_WITHIN_TOLERANCE.length} forecasted emission ratings within the delay tolerance`)
		core.debug(FORECASTED_EMISSION_RATINGS_WITHIN_TOLERANCE)

		// Find the lowest emission rating available within the tolerance window
		const LOWEST_FORECASTED_EMISSION_RATING = await _getLowestForecastedEmission(FORECASTED_EMISSION_RATINGS_WITHIN_TOLERANCE)

		core.info(
			`Lowest emission rating found within delay tolerance: ${LOWEST_FORECASTED_EMISSION_RATING.value} at ${LOWEST_FORECASTED_EMISSION_RATING.timestamp}`
		)
		core.debug(LOWEST_FORECASTED_EMISSION_RATING)

    // Get percentage difference between current and lowest forecasted emission rating
    let percentageDiff = 0
    if (LOWEST_FORECASTED_EMISSION_RATING.value < CURRENT_EMISSION_RATING.rating) {
      percentageDiff = (CURRENT_EMISSION_RATING.rating - LOWEST_FORECASTED_EMISSION_RATING.value) / CURRENT_EMISSION_RATING.rating * 100

      core.info(`Percentage difference between current and lowest forecasted emission rating: ${percentageDiff}`)
    }

		// Calculate how long the job should be delayed (in minutes)
		const JOB_DELAY = await _calculateJobDelay(CURRENT_EMISSION_RATING, LOWEST_FORECASTED_EMISSION_RATING)

		core.info(`Calculated job delay: ${JOB_DELAY} minutes`)

		// If the current emission rating is lower than any of the forecasted ones, then there's no need to delay
		// Otherwise, delay the job using a repo environment for the calculated amount of time
		if (JOB_DELAY == 0) {
			core.info(
				`Current emission rating (${CURRENT_EMISSION_RATING.rating}) is lower than the lowest forecasted emission rating (${LOWEST_FORECASTED_EMISSION_RATING.value}). No delay required.`
			)
      // Delete the environment created in previous run
      core.info(`Deleting environment ${ENV_NAME}in preparation for next run`)
      await octokit.rest.repos.deleteAnEnvironment({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        environment_name: ENV_NAME
      })
		} else {
			core.warning(
				`Current emission rating (${CURRENT_EMISSION_RATING.rating}) is higher than the lowest forecasted emission rating (${LOWEST_FORECASTED_EMISSION_RATING.value}). If the job is re-run, it will be delayed for ${JOB_DELAY} minutes.`
			)

      // Add a job summary for human-friendly output
      await core.summary
        .addHeading('Thank you for going green! 🌱')
        .addText(`This job has been delayed for ${JOB_DELAY} minutes in accordance with the set delay tolerance of ${delayTolerance} and the available carbon emission forecast. According to the forecast, this will represent a ${percentageDiff} % reduction in carbon emissions :tada:`)
        .addLink('Learn more about the Carbon Aware SDK and the Green Software Foundation', 'https://github.com/Green-Software-Foundation/carbon-aware-sdk')
        .write()

			await _delayJob(JOB_DELAY, octokit, github, ENV_NAME)
		}

		// TODO
		// Add job summary (markdown formatted)
		// Include:
		// - Delay tolerance
		// - The current emission rating found + timestamp
		// - The lowest forecasted emission rating found + timestamp
		// - Can we link the workflow job runs, to e.g. include something like "This jobs was delayed by X minutes, leading to a reduction of XX% emission rating"?
	}
}

run()

async function _getRunnerOs(platform) {
	switch (platform) {
		case 'linux':
			return 'linux'
		case 'darwin':
			return 'macos'
		case 'win32':
			return 'windows'
		default:
			core.warning('Unable to determine the OS of the runner, the workflow will continue.')
			return
	}
}

async function _getIPInfo() {
	const IPInfo = ipInfo()

	return IPInfo
}

async function _getRunnerLocation(location) {
	let matchingRegions = []

	for (const region in azureRegions) {
		if (azureRegions[region].state == location) {
			matchingRegions.push(region)
		}
	}

	// TODO - how to deal with multiple regions in the same state?
	//   E.g. there are two azure datacenters in Virginia, but it's hard to get granular enough data to distinguish the two wrt emission rating
	return matchingRegions[0]
}

async function _getCurrentEmissionLevel(apiUrl, region) {
	const response = await axios.get(`${apiUrl}/emissions/bylocations/best?location=${region}`)
	return response.data[0]
}

async function _getForecastedEmissionLevels(apiUrl, region) {
	const response = await axios.get(`${apiUrl}/emissions/forecasts/current?location=${region}`)
	return response.data
}

async function _getForecastWithinDelayTolerance(forecastData, delayTolerance) {
	let maxTimeStamp = new Date(new Date().getTime() + delayTolerance * 60000)
	let currentTime = new Date()

	let forecastWithinTolerance = forecastData.filter((entry) => {
		let forecastTimeStamp = new Date(entry.timestamp)
		// We only want the forecasts that are in the future and within the delay tolerance
		return forecastTimeStamp <= maxTimeStamp && forecastTimeStamp >= currentTime
	})
	return forecastWithinTolerance
}

async function _getLowestForecastedEmission(forecastData) {
	let lowestForecast = forecastData.reduce((prev, current) => {
		return prev.value < current.value ? prev : current
	})
	return lowestForecast
}

// Calculate how long a job should be delayed based on current vs forecasted emission ratings
async function _calculateJobDelay(CURRENT_EMISSION_RATING, LOWEST_FORECASTED_EMISSION_RATING) {
	if (LOWEST_FORECASTED_EMISSION_RATING.value < CURRENT_EMISSION_RATING.rating) {
		let jobDelay = _getTimeDiffMinutes(CURRENT_EMISSION_RATING.time, LOWEST_FORECASTED_EMISSION_RATING.timestamp)

		return jobDelay
	} else {
		let jobDelay = 0

		return jobDelay
	}
}

async function _getTimeDiffMinutes(time1, time2) {
	let dt1 = new Date(time1)
	let dt2 = new Date(time2)
	let timeDiffRaw = (dt2.getTime() - dt1.getTime()) / 1000 / 60
	let timeDiff = Math.round(timeDiffRaw)

	return timeDiff
}

async function _delayJob(minutes, octokit, github, envName) {
	// First we need to cancel the current workflow
	// There's no support currently for cancelling individual jobs, so we need to cancel the entire workflow

	await octokit.rest.actions.cancelWorkflowRun({
		owner: github.context.repo.owner,
		repo: github.context.repo.repo,
		run_id: github.context.runId,
	})

	// Create environment with a set wait timer
	// This is how we can use native GitHub Actions functionality to delay the job
	await octokit.rest.repos.createOrUpdateEnvironment({
		owner: github.context.repo.owner,
		repo: github.context.repo.repo,
		environment_name: envName,
		wait_timer: minutes,
	})

  core.setFailed(`Exiting, the job should be delayed for ${minutes} minutes`)
}
