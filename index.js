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

	// We only want to run the job if it hasn't already been delayed once (the current implementation is a "one-off" delay, to avoid infinite loops)
	// We decide whether the current job has already been delayed by looking at the amount of run attempts for this workflow run ID
	const workflowRun = await octokit.rest.actions.getWorkflowRun({
		owner: github.context.repo.owner,
		repo: github.context.repo.repo,
		run_id: github.context.runId,
	})

	if (workflowRun.data.run_attempt > 1) {
		core.info('This job has already been delayed once, the workflow will continue without taking further action.')
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

		// Calculate how long the job should be delayed (in minutes)
		const JOB_DELAY = await _calculateJobDelay(CURRENT_EMISSION_RATING, LOWEST_FORECASTED_EMISSION_RATING)

		core.info(`Calculated job delay: ${JOB_DELAY} minutes`)

		// If the current emission rating is lower than any of the forecasted ones, then there's no need to delay
		// Otherwise, delay the job using a repo environment for the calculated amount of time
		if (JOB_DELAY == 0) {
			core.info(
				`Current emission rating (${CURRENT_EMISSION_RATING.rating}) is lower than the lowest forecasted emission rating (${LOWEST_FORECASTED_EMISSION_RATING.value}). No delay required.`
			)
		} else {
			core.notice(
				`Current emission rating (${CURRENT_EMISSION_RATING.rating}) is higher than the lowest forecasted emission rating (${LOWEST_FORECASTED_EMISSION_RATING.value}). Delaying job for ${JOB_DELAY} minutes.`
			)

			await _delayJob(JOB_DELAY, octokit, github)
		}

		// TODO
		// Currently the loop is infinite: the action cancels the run, another workflow retriggers it (with a wait timer set on the environment), and if a better forecasted time is found during the second workflow run, then the loop repeats.
		// Target: we want the time delay to be a one off
		// Solution idea: in the action, check if the job has already been delayed once (use the context.payload.workflow_run.run_attempt attribute??). If false, run the action as usual.

		// TODO
		// We can't use the same environment with a fixed name, as several workflows might be targeting that environment at the same time and will lead to unexpected results
		// Solution idea: suffix the environment name with some identified, e.g. the workflow run ID. Alernatively, we delete the environment as part of the action. This is not ideal, as multiple jobs might be running simeoultaneously...

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
	//   E.g. there are two azure datacenters in Virginia, but it's hard to get granular enough data to distinguish the two
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

async function _delayJob(minutes, octokit, github) {
	// First we need to cancel the current workflow
	// There's no support currently for cancelling individual jobs, so we need to cancel the entire workflow

	await octokit.rest.actions.cancelWorkflowRun({
		owner: github.context.repo.owner,
		repo: github.context.repo.repo,
		run_id: github.context.runId,
	})

	// Create environment with a set wait timer
	// This is how we can use native GitHub Actions functionality to delay the job
	// TODO - find a better naming convention for the environment to avoid several jobs targeting and editing the same environment
	await octokit.rest.repos.createOrUpdateEnvironment({
		owner: github.context.repo.owner,
		repo: github.context.repo.repo,
		environment_name: 'green-env',
		wait_timer: minutes,
	})
}
