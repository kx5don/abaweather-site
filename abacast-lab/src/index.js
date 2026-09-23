const ABACAST_INSTRUCTIONS = [
  'You are AbaCast, a weather app\'s helpful personality. Write one concise "here\'s what matters" weather update for the specific location over roughly the next 8 hours.',
  '',
  'Use the NWS Area Forecast Discussion to understand the broader weather setup, timing, and forecaster reasoning. Then use the current local observation and point-specific next-8-hour forecast to describe how that setup is expected to affect the user\'s exact location. Do not treat these sources as conflicting alternatives; use the point forecast to localize the broader discussion.',
  '',
  'Ignore routine daytime warming and nighttime cooling unless the forecast discussion indicates a meaningful weather-driven change such as a front or precipitation. Never include the current temperature or place name in your response. Round precipitation chances to the nearest ten when you mention them. If the point-specific forecast shows precipitation chances of 10 percent or less, do not mention precipitation at all, even if the Area Forecast Discussion discusses precipitation elsewhere in the forecast area. Never use a specific clock time; use natural dayparts such as this afternoon, this evening, tonight, overnight, or tomorrow morning.',
  '',
  'Sound like a weather-obsessed dad texting a quick observation to his family: warm, witty, a little cheeky, conversational, and useful. Include playful wording, a mild joke, or a weather pun when it fits. Give an actionable recommendation when one is genuinely useful, but do not force one into quiet weather. End with one relevant emoji.',
  '',
  'The entire response, including spaces and emoji, must be 135 characters or fewer. Do not add a label such as "AbaCast:".'
].join('\n');

const DEFAULTS = {
  locationName: 'Plano, TX',
  latitude: 33.0198,
  longitude: -96.6989,
  timeZone: 'America/Chicago',
  openAIModel: 'gpt-5.6-luna',
  anthropicModel: 'claude-haiku-4-5-20251001',
  geminiModel: 'gemini-3.5-flash-lite',
  historyLimit: 20,
  manualIpCooldownSeconds: 60,
  manualGlobalCooldownSeconds: 30,
  retentionDays: 30
};

const PRICING = {
  openai: { input: 0.20, output: 1.20, asOf: '2026-09-23' },
  anthropic: { input: 1.00, output: 5.00, asOf: '2026-09-23' },
  gemini: { input: 0.30, output: 2.50, asOf: '2026-09-23' }
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (url.pathname === '/api/health' && request.method === 'GET') {
        return json({
          ok: true,
          service: 'AbaCast Model Lab',
          configuredProviders: {
            openai: Boolean(env.OPENAI_API_KEY),
            anthropic: Boolean(env.ANTHROPIC_API_KEY),
            gemini: Boolean(env.GEMINI_API_KEY)
          }
        });
      }

      if (url.pathname === '/api/latest' && request.method === 'GET') {
        const experiment = await getLatestExperiment(env.DB);
        return json({ ok: true, experiment });
      }

      if (url.pathname === '/api/history' && request.method === 'GET') {
        const requested = Number(url.searchParams.get('limit'));
        const limit = clampInteger(
          Number.isFinite(requested) ? requested : numberEnv(env.HISTORY_LIMIT, DEFAULTS.historyLimit),
          1,
          50
        );
        const experiments = await getExperimentHistory(env.DB, limit);
        return json({ ok: true, experiments });
      }

      if (url.pathname.startsWith('/api/experiments/') && request.method === 'GET') {
        const id = decodeURIComponent(url.pathname.slice('/api/experiments/'.length));
        const experiment = await getExperimentById(env.DB, id);
        if (!experiment) return json({ ok: false, error: 'Experiment not found' }, 404);
        return json({ ok: true, experiment });
      }

      if (url.pathname === '/api/generate' && request.method === 'POST') {
        if (!isAuthorizedGenerator(request, env)) {
          return json({ ok: false, error: 'Unauthorized' }, 401);
        }

        const bucket = currentScheduleBucket();
        const lock = await claimGenerationLock(env.DB, 'scheduled:' + bucket);

        if (!lock) {
          const existing = await getExperimentByScheduleBucket(env.DB, bucket);
          return json({
            ok: true,
            reused: true,
            experiment: existing
          });
        }

        try {
          const experiment = await generateExperiment(env, 'scheduled', bucket);
          return json({ ok: true, reused: false, experiment });
        } catch (error) {
          await releaseGenerationLock(env.DB, 'scheduled:' + bucket);
          console.error('Scheduled generation failed', error);
          return json({ ok: false, error: 'Experiment generation failed' }, 502);
        }
      }

      if (url.pathname === '/api/manual-run' && request.method === 'POST') {
        const rateLimit = await enforceManualRateLimit(request, env);
        if (!rateLimit.allowed) {
          return json({
            ok: false,
            error: 'Rate limit reached',
            retryAfterSeconds: rateLimit.retryAfterSeconds
          }, 429, { 'Retry-After': String(rateLimit.retryAfterSeconds) });
        }

        try {
          const experiment = await generateExperiment(env, 'manual', null);
          return json({ ok: true, experiment });
        } catch (error) {
          console.error('Manual generation failed', error);
          return json({ ok: false, error: 'Experiment generation failed' }, 502);
        }
      }

      if (url.pathname.startsWith('/api/')) {
        return json({ ok: false, error: 'Not found' }, 404);
      }

      if (env.ASSETS && (request.method === 'GET' || request.method === 'HEAD')) {
        return env.ASSETS.fetch(request);
      }

      return json({ ok: false, error: 'Not found' }, 404);
    } catch (error) {
      console.error('Unhandled request error', error);
      return json({ ok: false, error: 'Internal server error' }, 500);
    }
  }
};

async function generateExperiment(env, source, scheduleBucket) {
  if (!env.DB) throw new Error('D1 binding DB is required');

  const fixture = await buildWeatherFixture(env);

  const [openai, anthropic, gemini] = await Promise.all([
    runOpenAI(fixture.inputText, env),
    runAnthropic(fixture.inputText, env),
    runGemini(fixture.inputText, env)
  ]);

  const experiment = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    createdAtEpoch: Math.floor(Date.now() / 1000),
    source,
    scheduleBucket,
    location: fixture.location,
    forecastOffice: fixture.forecastOffice,
    station: fixture.station,
    weather: fixture.weather,
    afd: fixture.afd,
    systemPrompt: ABACAST_INSTRUCTIONS,
    inputText: fixture.inputText,
    models: { openai, anthropic, gemini }
  };

  await saveExperiment(env.DB, experiment);

  const retentionDays = clampInteger(numberEnv(env.RETENTION_DAYS, DEFAULTS.retentionDays), 1, 365);
  const cutoff = experiment.createdAtEpoch - retentionDays * 86400;
  await Promise.all([
    env.DB.prepare('DELETE FROM experiments WHERE created_at_epoch < ?1').bind(cutoff).run(),
    env.DB.prepare('DELETE FROM generation_locks WHERE acquired_at_epoch < ?1').bind(cutoff).run(),
    env.DB.prepare('DELETE FROM manual_rate_limits WHERE last_run_epoch < ?1').bind(experiment.createdAtEpoch - 86400).run()
  ]);

  return experiment;
}

async function buildWeatherFixture(env) {
  const locationName = env.LOCATION_NAME || DEFAULTS.locationName;
  const latitude = numberEnv(env.LATITUDE, DEFAULTS.latitude);
  const longitude = numberEnv(env.LONGITUDE, DEFAULTS.longitude);
  const timeZone = env.TIME_ZONE || DEFAULTS.timeZone;

  const pointUrl = 'https://api.weather.gov/points/' + latitude.toFixed(4) + ',' + longitude.toFixed(4);
  const point = await fetchNWSJSON(pointUrl);
  const pointProperties = point && point.properties ? point.properties : {};

  const forecastOffice = normalizeForecastOffice(pointProperties.cwa);
  const hourlyUrl = pointProperties.forecastHourly;
  const stationsUrl = pointProperties.observationStations;

  if (!hourlyUrl || !stationsUrl) {
    throw new Error('NWS point metadata is missing hourly forecast or observation stations');
  }

  const afdPromise = forecastOffice
    ? fetchAreaForecastDiscussion(forecastOffice).catch(function(error) {
        console.warn('AFD unavailable', forecastOffice, error && error.message ? error.message : error);
        return null;
      })
    : Promise.resolve(null);

  const [hourly, stations, afd] = await Promise.all([
    fetchNWSJSON(hourlyUrl),
    fetchNWSJSON(stationsUrl),
    afdPromise
  ]);

  const periods = Array.isArray(hourly && hourly.properties && hourly.properties.periods)
    ? hourly.properties.periods.slice(0, 8)
    : [];

  if (!periods.length) throw new Error('NWS hourly forecast returned no periods');

  const stationUrl = pickStationUrl(stations);
  const stationFeature = pickStationFeature(stations, stationUrl);

  let observation = null;
  if (stationUrl) {
    try {
      observation = await fetchNWSJSON(stationUrl.replace(/\/$/, '') + '/observations/latest');
    } catch (error) {
      console.warn('Latest observation unavailable', error && error.message ? error.message : error);
    }
  }

  const station = {
    id: stationFeature && stationFeature.properties && stationFeature.properties.stationIdentifier
      ? stationFeature.properties.stationIdentifier
      : stationUrl ? stationUrl.split('/').filter(Boolean).pop() : null,
    name: stationFeature && stationFeature.properties ? stationFeature.properties.name || null : null
  };

  const current = normalizeObservation(observation);
  const hours = periods.map(normalizeHourlyPeriod);

  const weather = { current, hours };
  const inputText = buildModelInput({
    locationName,
    timeZone,
    forecastOffice,
    station,
    current,
    hours,
    afd
  });

  return {
    location: { name: locationName, latitude, longitude, timeZone },
    forecastOffice,
    station,
    weather,
    afd,
    inputText
  };
}

function buildModelInput(data) {
  const lines = [];
  lines.push('Location: ' + data.locationName);
  lines.push('');

  if (data.current) {
    const stationLabel = data.station && data.station.id ? ' (' + data.station.id + ')' : '';
    lines.push('Current local observation' + stationLabel + ':');
    lines.push('Observed: ' + formatInTimeZone(data.current.timestamp, data.timeZone));
    lines.push('Conditions: ' + valueOrUnavailable(data.current.description));
    lines.push('Temperature: ' + formatTemperature(data.current.temperatureF));
    lines.push('Dew point: ' + formatTemperature(data.current.dewpointF));
    lines.push('Humidity: ' + formatNumber(data.current.humidityPercent, '%'));
    lines.push('Wind: ' + formatWind(data.current.windDirectionDegrees, data.current.windSpeedMph, data.current.windGustMph));
    lines.push('Pressure: ' + formatNumber(data.current.pressureInHg, ' inHg', 2));
  } else {
    lines.push('Current local observation: unavailable');
  }

  lines.push('');
  lines.push('Point-specific next-8-hour forecast:');

  data.hours.forEach(function(hour) {
    const pop = Number.isFinite(hour.precipitationChancePercent) ? Math.round(hour.precipitationChancePercent) + '%' : 'unavailable';
    const temp = Number.isFinite(hour.temperatureF) ? Math.round(hour.temperatureF) + '°F' : 'unavailable';
    const wind = [hour.windDirection, hour.windSpeed].filter(Boolean).join(' ') || 'unavailable';
    lines.push(
      formatHour(hour.startTime, data.timeZone) + ': ' +
      (hour.shortForecast || 'Forecast unavailable') +
      ' | ' + temp +
      ' | precipitation chance ' + pop +
      ' | wind ' + wind
    );
  });

  lines.push('');

  if (data.afd && data.afd.text) {
    lines.push(
      'NWS Area Forecast Discussion for office ' +
      (data.forecastOffice || 'unknown') +
      ' (issued ' +
      formatInTimeZone(data.afd.issuanceTime, data.timeZone) +
      '):'
    );
    lines.push('---');
    lines.push(data.afd.text);
    lines.push('---');
    lines.push('');
    lines.push('Use the discussion for meteorological significance, but ground the final AbaCast in the local observation and point-specific next-8-hour forecast above.');
  } else {
    lines.push('No current NWS Area Forecast Discussion was available. Use the local observation and next-8-hour point forecast only.');
  }

  return lines.join('\n');
}

async function runOpenAI(inputText, env) {
  const model = env.OPENAI_MODEL || DEFAULTS.openAIModel;
  if (!env.OPENAI_API_KEY) return missingProviderResult('OpenAI', model, 'OPENAI_API_KEY');

  const started = Date.now();

  try {
    const response = await fetchWithTimeout('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.OPENAI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        reasoning: { effort: 'low' },
        instructions: ABACAST_INSTRUCTIONS,
        input: inputText,
        max_output_tokens: 180
      })
    }, 30000);

    const payload = await safeJson(response);
    if (!response.ok) throw new Error('OpenAI HTTP ' + response.status);

    const text = extractOpenAIText(payload);
    if (!text) throw new Error('OpenAI returned no text');

    const inputTokens = numberOrNull(payload && payload.usage && payload.usage.input_tokens);
    const outputTokens = numberOrNull(payload && payload.usage && payload.usage.output_tokens);
    const reasoningTokens = numberOrNull(
      payload && payload.usage && payload.usage.output_tokens_details && payload.usage.output_tokens_details.reasoning_tokens
    );

    return successfulProviderResult({
      provider: 'OpenAI',
      model,
      text,
      latencyMs: Date.now() - started,
      inputTokens,
      outputTokens,
      reasoningTokens,
      estimatedCostUsd: estimateCost(PRICING.openai, inputTokens, outputTokens),
      pricing: PRICING.openai
    });
  } catch (error) {
    return failedProviderResult('OpenAI', model, Date.now() - started, error);
  }
}

async function runAnthropic(inputText, env) {
  const model = env.ANTHROPIC_MODEL || DEFAULTS.anthropicModel;
  if (!env.ANTHROPIC_API_KEY) return missingProviderResult('Anthropic', model, 'ANTHROPIC_API_KEY');

  const started = Date.now();

  try {
    const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model,
        max_tokens: 180,
        system: ABACAST_INSTRUCTIONS,
        messages: [{ role: 'user', content: inputText }]
      })
    }, 30000);

    const payload = await safeJson(response);
    if (!response.ok) throw new Error('Anthropic HTTP ' + response.status);

    const text = Array.isArray(payload && payload.content)
      ? payload.content.filter(function(block) { return block && block.type === 'text'; }).map(function(block) { return block.text || ''; }).join('').trim()
      : '';

    if (!text) throw new Error('Anthropic returned no text');

    const inputTokens = numberOrNull(payload && payload.usage && payload.usage.input_tokens);
    const outputTokens = numberOrNull(payload && payload.usage && payload.usage.output_tokens);

    return successfulProviderResult({
      provider: 'Anthropic',
      model,
      text,
      latencyMs: Date.now() - started,
      inputTokens,
      outputTokens,
      reasoningTokens: null,
      estimatedCostUsd: estimateCost(PRICING.anthropic, inputTokens, outputTokens),
      pricing: PRICING.anthropic
    });
  } catch (error) {
    return failedProviderResult('Anthropic', model, Date.now() - started, error);
  }
}

async function runGemini(inputText, env) {
  const model = env.GEMINI_MODEL || DEFAULTS.geminiModel;
  if (!env.GEMINI_API_KEY) return missingProviderResult('Google', model, 'GEMINI_API_KEY');

  const started = Date.now();

  try {
    const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
    const response = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: {
        'x-goog-api-key': env.GEMINI_API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: ABACAST_INSTRUCTIONS }]
        },
        contents: [{
          role: 'user',
          parts: [{ text: inputText }]
        }],
        generationConfig: {
          maxOutputTokens: 180,
          thinkingConfig: {
            thinkingLevel: 'minimal'
          }
        }
      })
    }, 30000);

    const payload = await safeJson(response);
    if (!response.ok) throw new Error('Gemini HTTP ' + response.status);

    const parts = payload && payload.candidates && payload.candidates[0] && payload.candidates[0].content
      ? payload.candidates[0].content.parts
      : null;
    const text = Array.isArray(parts)
      ? parts.filter(function(part) { return part && typeof part.text === 'string'; }).map(function(part) { return part.text; }).join('').trim()
      : '';

    if (!text) throw new Error('Gemini returned no text');

    const usage = payload && payload.usageMetadata ? payload.usageMetadata : {};
    const inputTokens = numberOrNull(usage.promptTokenCount);
    const outputTokens = numberOrNull(usage.candidatesTokenCount);
    const reasoningTokens = numberOrNull(usage.thoughtsTokenCount);
    const billableOutputTokens = sumNullable(outputTokens, reasoningTokens);

    return successfulProviderResult({
      provider: 'Google',
      model,
      text,
      latencyMs: Date.now() - started,
      inputTokens,
      outputTokens,
      reasoningTokens,
      estimatedCostUsd: estimateCost(PRICING.gemini, inputTokens, billableOutputTokens),
      pricing: PRICING.gemini
    });
  } catch (error) {
    return failedProviderResult('Google', model, Date.now() - started, error);
  }
}

function successfulProviderResult(result) {
  const text = result.text.trim();
  const charCount = Array.from(text).length;
  const endsWithEmoji = /\p{Extended_Pictographic}\uFE0F?$/u.test(text);

  return {
    ok: true,
    provider: result.provider,
    model: result.model,
    text,
    charCount,
    withinCharacterLimit: charCount <= 135,
    endsWithEmoji,
    latencyMs: result.latencyMs,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    reasoningTokens: result.reasoningTokens,
    estimatedCostUsd: result.estimatedCostUsd,
    pricing: result.pricing
  };
}

function missingProviderResult(provider, model, secretName) {
  return {
    ok: false,
    provider,
    model,
    error: secretName + ' is not configured',
    latencyMs: null,
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    estimatedCostUsd: null
  };
}

function failedProviderResult(provider, model, latencyMs, error) {
  return {
    ok: false,
    provider,
    model,
    error: error && error.message ? error.message : 'Provider request failed',
    latencyMs,
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    estimatedCostUsd: null
  };
}

async function fetchAreaForecastDiscussion(office) {
  const latestUrl = 'https://api.weather.gov/products/types/AFD/locations/' + encodeURIComponent(office) + '/latest';
  const latest = await fetchNWSJSON(latestUrl);

  const issuanceTime = typeof latest.issuanceTime === 'string' ? latest.issuanceTime : null;
  if (issuanceTime) {
    const ageMs = Date.now() - Date.parse(issuanceTime);
    if (Number.isFinite(ageMs) && ageMs > 18 * 60 * 60 * 1000) {
      throw new Error('Latest AFD is stale');
    }
  }

  const fullText = typeof latest.productText === 'string' ? latest.productText.trim() : '';
  if (!fullText) throw new Error('AFD product text is empty');

  const shortTermText = extractAFDShortTerm(fullText);
  const contextText = shortTermText || fullText;

  return {
    office,
    issuanceTime,
    section: shortTermText ? 'SHORT TERM' : 'FULL AFD FALLBACK',
    text: contextText.length > 18000 ? contextText.slice(0, 18000) : contextText
  };
}

function extractAFDShortTerm(text) {
  const start = text.search(/^\.SHORT TERM(?:\.\.\.|\b).*$/im);
  if (start < 0) return null;

  const afterHeading = text.slice(start);
  const firstNewline = afterHeading.indexOf('\n');
  if (firstNewline < 0) return null;

  const bodyStart = start + firstNewline + 1;
  const remainder = text.slice(bodyStart);
  const nextSection = remainder.search(/^\.[A-Z][A-Z /&-]*(?:\.\.\.|\b).*$/m);
  const section = (nextSection >= 0 ? remainder.slice(0, nextSection) : remainder).trim();

  return section || null;
}

async function fetchNWSJSON(url) {
  const response = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'AbaCastModelLab/1.0 (abaweather@outlook.com)',
      'Accept': 'application/ld+json, application/json'
    }
  }, 15000);

  if (!response.ok) throw new Error('NWS HTTP ' + response.status + ' for ' + url);
  return response.json();
}

function pickStationUrl(stations) {
  if (stations && Array.isArray(stations.observationStations) && stations.observationStations.length) {
    return stations.observationStations[0];
  }
  if (stations && Array.isArray(stations.features) && stations.features.length && stations.features[0].id) {
    return stations.features[0].id;
  }
  return null;
}

function pickStationFeature(stations, stationUrl) {
  if (!stations || !Array.isArray(stations.features) || !stations.features.length) return null;
  if (!stationUrl) return stations.features[0];
  return stations.features.find(function(feature) { return feature && feature.id === stationUrl; }) || stations.features[0];
}

function normalizeObservation(observation) {
  const p = observation && observation.properties ? observation.properties : null;
  if (!p) return null;

  return {
    timestamp: p.timestamp || null,
    description: p.textDescription || null,
    temperatureF: celsiusToFahrenheit(quantity(p.temperature)),
    dewpointF: celsiusToFahrenheit(quantity(p.dewpoint)),
    humidityPercent: quantity(p.relativeHumidity),
    windSpeedMph: kilometersPerHourToMph(quantity(p.windSpeed)),
    windGustMph: kilometersPerHourToMph(quantity(p.windGust)),
    windDirectionDegrees: quantity(p.windDirection),
    pressureInHg: pascalsToInHg(quantity(p.barometricPressure))
  };
}

function normalizeHourlyPeriod(period) {
  return {
    startTime: period.startTime || null,
    temperatureF: Number.isFinite(period.temperature) ? period.temperature : null,
    shortForecast: period.shortForecast || null,
    precipitationChancePercent: period.probabilityOfPrecipitation && Number.isFinite(period.probabilityOfPrecipitation.value)
      ? period.probabilityOfPrecipitation.value
      : 0,
    windSpeed: period.windSpeed || null,
    windDirection: period.windDirection || null,
    isDaytime: Boolean(period.isDaytime)
  };
}

async function saveExperiment(db, experiment) {
  await db.prepare(
    'INSERT INTO experiments (' +
    'id, created_at, created_at_epoch, source, schedule_bucket, location_name, latitude, longitude, time_zone, ' +
    'forecast_office, station_id, station_name, weather_json, afd_json, system_prompt, input_text, ' +
    'openai_json, anthropic_json, gemini_json' +
    ') VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)'
  ).bind(
    experiment.id,
    experiment.createdAt,
    experiment.createdAtEpoch,
    experiment.source,
    experiment.scheduleBucket,
    experiment.location.name,
    experiment.location.latitude,
    experiment.location.longitude,
    experiment.location.timeZone,
    experiment.forecastOffice,
    experiment.station && experiment.station.id,
    experiment.station && experiment.station.name,
    JSON.stringify(experiment.weather),
    JSON.stringify(experiment.afd),
    experiment.systemPrompt,
    experiment.inputText,
    JSON.stringify(experiment.models.openai),
    JSON.stringify(experiment.models.anthropic),
    JSON.stringify(experiment.models.gemini)
  ).run();
}

async function getLatestExperiment(db) {
  const row = await db.prepare('SELECT * FROM experiments ORDER BY created_at_epoch DESC LIMIT 1').first();
  return hydrateExperiment(row);
}

async function getExperimentById(db, id) {
  if (!id) return null;
  const row = await db.prepare('SELECT * FROM experiments WHERE id = ?1 LIMIT 1').bind(id).first();
  return hydrateExperiment(row);
}

async function getExperimentByScheduleBucket(db, bucket) {
  const row = await db.prepare('SELECT * FROM experiments WHERE schedule_bucket = ?1 LIMIT 1').bind(bucket).first();
  return hydrateExperiment(row);
}

async function getExperimentHistory(db, limit) {
  const result = await db.prepare(
    'SELECT id, created_at, created_at_epoch, source, location_name, forecast_office, ' +
    'openai_json, anthropic_json, gemini_json FROM experiments ORDER BY created_at_epoch DESC LIMIT ?1'
  ).bind(limit).all();

  return (result.results || []).map(function(row) {
    return {
      id: row.id,
      createdAt: row.created_at,
      createdAtEpoch: row.created_at_epoch,
      source: row.source,
      locationName: row.location_name,
      forecastOffice: row.forecast_office,
      models: {
        openai: compactProvider(parseJson(row.openai_json)),
        anthropic: compactProvider(parseJson(row.anthropic_json)),
        gemini: compactProvider(parseJson(row.gemini_json))
      }
    };
  });
}

function hydrateExperiment(row) {
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    createdAtEpoch: row.created_at_epoch,
    source: row.source,
    scheduleBucket: row.schedule_bucket,
    location: {
      name: row.location_name,
      latitude: row.latitude,
      longitude: row.longitude,
      timeZone: row.time_zone
    },
    forecastOffice: row.forecast_office,
    station: {
      id: row.station_id,
      name: row.station_name
    },
    weather: parseJson(row.weather_json),
    afd: parseJson(row.afd_json),
    systemPrompt: row.system_prompt,
    inputText: row.input_text,
    models: {
      openai: parseJson(row.openai_json),
      anthropic: parseJson(row.anthropic_json),
      gemini: parseJson(row.gemini_json)
    }
  };
}

function compactProvider(provider) {
  if (!provider) return null;
  return {
    ok: Boolean(provider.ok),
    model: provider.model || null,
    charCount: provider.charCount || null,
    latencyMs: provider.latencyMs || null
  };
}

async function claimGenerationLock(db, lockKey) {
  const now = Math.floor(Date.now() / 1000);
  const result = await db.prepare(
    'INSERT OR IGNORE INTO generation_locks (lock_key, acquired_at_epoch) VALUES (?1, ?2)'
  ).bind(lockKey, now).run();
  return Boolean(result && result.meta && result.meta.changes);
}

async function releaseGenerationLock(db, lockKey) {
  await db.prepare('DELETE FROM generation_locks WHERE lock_key = ?1').bind(lockKey).run();
}

async function enforceManualRateLimit(request, env) {
  const now = Math.floor(Date.now() / 1000);
  const ipCooldown = clampInteger(
    numberEnv(env.MANUAL_IP_COOLDOWN_SECONDS, DEFAULTS.manualIpCooldownSeconds),
    10,
    3600
  );
  const globalCooldown = clampInteger(
    numberEnv(env.MANUAL_GLOBAL_COOLDOWN_SECONDS, DEFAULTS.manualGlobalCooldownSeconds),
    5,
    3600
  );

  const ip = request.headers.get('CF-Connecting-IP') || 'local-development';
  const ipHash = await hashClientIdentifier(ip, env.RATE_LIMIT_SALT || 'development-only-change-me');

  const ipClaim = await claimRateLimit(env.DB, 'ip:' + ipHash, now, ipCooldown);
  if (!ipClaim.allowed) return ipClaim;

  const globalClaim = await claimRateLimit(env.DB, 'global', now, globalCooldown);
  if (!globalClaim.allowed) return globalClaim;

  return { allowed: true, retryAfterSeconds: 0 };
}

async function claimRateLimit(db, key, now, cooldownSeconds) {
  const result = await db.prepare(
    'INSERT INTO manual_rate_limits (rate_key, last_run_epoch) VALUES (?1, ?2) ' +
    'ON CONFLICT(rate_key) DO UPDATE SET last_run_epoch = excluded.last_run_epoch ' +
    'WHERE excluded.last_run_epoch - manual_rate_limits.last_run_epoch >= ?3'
  ).bind(key, now, cooldownSeconds).run();

  if (result && result.meta && result.meta.changes) {
    return { allowed: true, retryAfterSeconds: 0 };
  }

  const row = await db.prepare(
    'SELECT last_run_epoch FROM manual_rate_limits WHERE rate_key = ?1 LIMIT 1'
  ).bind(key).first();

  const elapsed = row && Number.isFinite(row.last_run_epoch) ? now - row.last_run_epoch : 0;
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, cooldownSeconds - elapsed)
  };
}

async function hashClientIdentifier(value, salt) {
  const bytes = new TextEncoder().encode(salt + ':' + value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(function(byte) {
    return byte.toString(16).padStart(2, '0');
  }).join('');
}

function isAuthorizedGenerator(request, env) {
  if (!env.GENERATE_SECRET) return false;
  const authorization = request.headers.get('Authorization') || '';
  return authorization === 'Bearer ' + env.GENERATE_SECRET;
}

function currentScheduleBucket() {
  return String(Math.floor(Date.now() / (15 * 60 * 1000)));
}

function extractOpenAIText(response) {
  if (response && typeof response.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const output = response && Array.isArray(response.output) ? response.output : [];
  for (const item of output) {
    const content = item && Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (part && part.type === 'output_text' && typeof part.text === 'string' && part.text.trim()) {
        return part.text.trim();
      }
    }
  }

  return '';
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(function() { controller.abort(); }, timeoutMs);

  try {
    return await fetch(url, Object.assign({}, options || {}, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function estimateCost(pricing, inputTokens, outputTokens) {
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return null;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1000000;
}

function sumNullable(a, b) {
  const aValue = Number.isFinite(a) ? a : 0;
  const bValue = Number.isFinite(b) ? b : 0;
  if (!Number.isFinite(a) && !Number.isFinite(b)) return null;
  return aValue + bValue;
}

function quantity(value) {
  return value && Number.isFinite(value.value) ? value.value : null;
}

function celsiusToFahrenheit(value) {
  return Number.isFinite(value) ? value * 9 / 5 + 32 : null;
}

function kilometersPerHourToMph(value) {
  return Number.isFinite(value) ? value * 0.621371 : null;
}

function pascalsToInHg(value) {
  return Number.isFinite(value) ? value / 3386.389 : null;
}

function normalizeForecastOffice(value) {
  if (typeof value !== 'string') return null;
  const office = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(office) ? office : null;
}

function degreesToCompass(degrees) {
  if (!Number.isFinite(degrees)) return null;
  const points = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return points[Math.round(((degrees % 360) + 360) % 360 / 22.5) % 16];
}

function formatWind(directionDegrees, speedMph, gustMph) {
  if (!Number.isFinite(speedMph)) return 'unavailable';
  const direction = degreesToCompass(directionDegrees);
  let text = (direction ? direction + ' ' : '') + Math.round(speedMph) + ' mph';
  if (Number.isFinite(gustMph) && gustMph > speedMph + 2) text += ', gusting ' + Math.round(gustMph) + ' mph';
  return text;
}

function formatTemperature(value) {
  return Number.isFinite(value) ? Math.round(value) + '°F' : 'unavailable';
}

function formatNumber(value, suffix, digits) {
  if (!Number.isFinite(value)) return 'unavailable';
  return value.toFixed(Number.isFinite(digits) ? digits : 0) + suffix;
}

function formatHour(value, timeZone) {
  if (!value) return 'Unknown time';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric'
  }).format(date);
}

function formatInTimeZone(value, timeZone) {
  if (!value) return 'time unavailable';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  }).format(date);
}

function valueOrUnavailable(value) {
  return value || 'unavailable';
}

function numberEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function clampInteger(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function parseJson(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function json(payload, status, extraHeaders) {
  const headers = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }, extraHeaders || {});
  return new Response(JSON.stringify(payload), { status: status || 200, headers });
}
