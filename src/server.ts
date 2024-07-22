import express, { Request, Response } from "express";
import SpotifyWebApi from "spotify-web-api-node";
import Anthropic from "@anthropic-ai/sdk";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { RequestQueue } from "./requestQueue";
import { formatSpotifyError } from "./utils";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = 3000;

// Environment setup
const isDevelopment = process.env.NODE_ENV !== "production";
const savedPlaylistsPath = path.join(__dirname, "..", "saved_playlists.json");

// Spotify API credentials (you'd need to set these up)
const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: process.env.SPOTIFY_REDIRECT_URI,
});

// Anthropic API setup
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const tokenPath = path.join(__dirname, "..", "token.json");

interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

interface LikedSong {
  name: string;
  artist: string;
  id: string;
}

interface Song {
  title: string;
  artist: string;
}

interface Playlist {
  name: string;
  description: string;
  songs: Song[];
}

const requestQueue = new RequestQueue();

// Logging function
const log = (message: string) => {
  if (isDevelopment) {
    console.log(`[${new Date().toISOString()}] ${message}`);
  }
};

// Middleware
app.use(express.json());

// Middleware to refresh token before each request
app.use(async (req: Request, res: Response, next: Function) => {
  if (req.path !== "/login" && req.path !== "/callback") {
    try {
      log(`Refreshing token for path: ${req.path}`);
      await refreshTokenIfNeeded();
      next();
    } catch (error) {
      log(`Token refresh failed: ${error}`);
      res.status(401).send("Authentication required. Please log in again.");
    }
  } else {
    next();
  }
});

app.get("/", (_req: Request, res: Response) => {
  const htmlResponse = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>AI Playlist Generator</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          line-height: 1.6;
          color: #333;
          max-width: 800px;
          margin: 0 auto;
          padding: 20px;
          background-color: #f4f4f4;
        }
        h1 {
          color: #1DB954;
          text-align: center;
        }
        .button-container {
          display: flex;
          justify-content: space-around;
          margin-top: 50px;
        }
        .button {
          display: inline-block;
          background-color: #1DB954;
          color: white;
          padding: 10px 20px;
          text-decoration: none;
          border-radius: 5px;
          font-weight: bold;
        }
        #customPrompt {
          width: 100%;
          padding: 10px;
          margin-top: 20px;
        }
        #submitCustom {
          display: block;
          margin: 20px auto;
        }
        .nav {
          background-color: #1DB954;
          color: white;
          padding: 10px;
          margin-bottom: 20px;
        }
        .nav a {
          color: white;
          text-decoration: none;
          margin-right: 15px;
        }
      </style>
    </head>
    <body>
      <div class="nav">
        <a href="/">Home</a>
        <a href="/preview-playlists">Random Playlists</a>
      </div>
      <h1>AI Playlist Generator</h1>
      <div class="button-container">
        <a href="/preview-playlists" class="button">Generate Random Playlists</a>
        <a href="#" class="button" id="customButton">Create Custom Playlist</a>
      </div>
      <textarea id="customPrompt" rows="4" placeholder="Enter your playlist description here..." style="display: none;"></textarea>
      <button id="submitCustom" class="button" style="display: none;">Create Playlist</button>
      
      <script>
        document.getElementById('customButton').addEventListener('click', function(e) {
          e.preventDefault();
          document.getElementById('customPrompt').style.display = 'block';
          document.getElementById('submitCustom').style.display = 'block';
        });

        document.getElementById('submitCustom').addEventListener('click', function() {
          const prompt = document.getElementById('customPrompt').value;
          fetch('/create-custom-playlist', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ prompt: prompt }),
          })
          .then(response => response.text())
          .then(html => {
            document.body.innerHTML = html;
          })
          .catch((error) => {
            console.error('Error:', error);
            alert('An error occurred while creating the playlist.');
          });
        });
      </script>
    </body>
    </html>
  `;

  res.send(htmlResponse);
});

// Routes
app.get("/login", (_req: Request, res: Response) => {
  log("Initiating Spotify login");
  const scopes = ["user-library-read", "playlist-modify-private"];
  res.redirect(spotifyApi.createAuthorizeURL(scopes, "asd"));
});

app.get("/callback", async (req: Request, res: Response) => {
  const { code } = req.query;
  try {
    log("Received callback from Spotify");
    const data = await spotifyApi.authorizationCodeGrant(code as string);
    const { access_token, refresh_token, expires_in } = data.body;

    await fs.writeFile(
      tokenPath,
      JSON.stringify({
        access_token,
        refresh_token,
        expires_at: Date.now() + expires_in * 1000,
      })
    );

    log("Login successful, tokens saved");
    res.send("Login successful! You can now use the other endpoints.");
  } catch (error) {
    log(`Login error: ${error}`);
    res.status(400).send(`Error: ${(error as Error).message}`);
  }
});

app.get("/liked-songs", async (_req: Request, res: Response) => {
  try {
    log("Fetching liked songs");
    const allLikedSongs = await getAllLikedSongs();
    log(`Fetched ${allLikedSongs.length} liked songs`);
    res.json(allLikedSongs);
  } catch (error) {
    log(`Error fetching liked songs: ${error}`);
    res.status(500).send(`Error: ${(error as Error).message}`);
  }
});

app.get("/generate-playlists", async (_req: Request, res: Response) => {
  try {
    log("Generating playlists");
    const likedSongs = await getAllLikedSongs();
    const playlists = await generateOrLoadPlaylists(likedSongs);

    await fs.writeFile(savedPlaylistsPath, JSON.stringify(playlists, null, 2));
    log(`Generated ${playlists.length} playlists and saved to file`);

    res.json(playlists);
  } catch (error) {
    log(`Error generating playlists: ${error}`);
    res.status(500).send(`Error: ${(error as Error).message}`);
  }
});

async function findTrackUris(
  songs: { title: string; artist: string }[]
): Promise<(string | undefined)[]> {
  const batchSize = 20; // Spotify allows up to 20 tracks per request
  const batches = [];

  for (let i = 0; i < songs.length; i += batchSize) {
    batches.push(songs.slice(i, i + batchSize));
  }

  const results = await Promise.all(
    batches.map(async (batch) => {
      return requestQueue.add(async () => {
        const uris = await Promise.all(
          batch.map(async (song) => {
            try {
              // First, try to find the exact song
              const exactSearch = await spotifyApi.searchTracks(
                `track:${song.title} artist:${song.artist}`
              );
              if (exactSearch.body.tracks?.items.length ?? 0 > 0) {
                log(`Found exact track: ${song.title} by ${song.artist}`);
                return exactSearch.body.tracks?.items[0].uri;
              }

              // If exact song not found, search for the artist's top tracks
              log(
                `Could not find exact track: ${song.title} by ${song.artist} Searching for artist: ${song.artist}`
              );
              const artistSearch = await spotifyApi.searchArtists(song.artist);
              if (artistSearch.body.artists?.items.length ?? 0 > 0) {
                const artistId = artistSearch.body.artists!.items[0].id;
                const topTracks = await spotifyApi.getArtistTopTracks(
                  artistId,
                  "US"
                );
                if (topTracks.body.tracks.length > 0) {
                  // Randomly select one of the top 5 tracks (or fewer if there aren't 5)
                  const randomIndex = Math.floor(
                    Math.random() * Math.min(5, topTracks.body.tracks.length)
                  );
                  log(`Found track for artist: ${song.artist}`);
                  return topTracks.body.tracks[randomIndex].uri;
                }
              }
              log(`No tracks found for artist: ${song.artist}`);
              return undefined;
            } catch (error) {
              log(
                `Error searching for track "${song.title}" by ${song.artist}: ${formatSpotifyError(error)}`
              );
              return undefined;
            }
          })
        );
        return uris;
      });
    })
  );

  return results.flat();
}

function sanitizePlaylistData(playlist: Playlist): Playlist {
  return {
    name: playlist.name.trim().slice(0, 100), // Spotify has a 100 character limit for playlist names
    description: playlist.description.trim().slice(0, 300), // 300 character limit for descriptions
    songs: playlist.songs,
  };
}

app.get("/preview-playlists", async (_req: Request, res: Response) => {
  try {
    await refreshTokenIfNeeded();

    log("Fetching all playlists");
    const playlists: Playlist[] = JSON.parse(
      await fs.readFile(savedPlaylistsPath, "utf8")
    );

    const createdPlaylistIds: string[] = [];
    const playlistEmbeds: string[] = [];

    for (const playlist of playlists) {
      try {
        log(`Processing playlist: ${playlist.name}`);
        const trackUris = await findTrackUris(playlist.songs);

        const validTrackUris = trackUris.filter(
          (uri): uri is string => uri !== undefined
        );
        log(
          `Found ${validTrackUris.length} valid track URIs for ${playlist.name}`
        );

        if (validTrackUris.length === 0) {
          log(`No valid tracks found for playlist: ${playlist.name}`);
          continue;
        }

        const sanitizedPlaylist = sanitizePlaylistData(playlist);

        log(`Attempting to create playlist: ${sanitizedPlaylist.name}`);
        log(`Playlist description: ${sanitizedPlaylist.description}`);
        log(`Number of valid tracks: ${validTrackUris.length}`);

        // Create the playlist
        const newPlaylist = await requestQueue.add(() =>
          spotifyApi.createPlaylist(sanitizedPlaylist.name, {
            description: sanitizedPlaylist.description,
            public: false,
          })
        );

        log(`Successfully created playlist: ${newPlaylist.body.id}`);

        // Add tracks to the playlist
        const batchSize = 100; // Spotify allows up to 100 tracks per request
        for (let i = 0; i < validTrackUris.length; i += batchSize) {
          const batch = validTrackUris.slice(i, i + batchSize);
          await requestQueue.add(() =>
            spotifyApi.addTracksToPlaylist(newPlaylist.body.id, batch)
          );
        }

        createdPlaylistIds.push(newPlaylist.body.id);

        playlistEmbeds.push(`
          <div class="playlist-card">
            <h2>${sanitizedPlaylist.name}</h2>
            <p>${sanitizedPlaylist.description}</p>
            <iframe 
              src="https://open.spotify.com/embed/playlist/${newPlaylist.body.id}?utm_source=generator" 
              width="100%" 
              height="352" 
              frameBorder="0" 
              allowfullscreen="" 
              allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" 
              loading="lazy">
            </iframe>
          </div>
        `);
      } catch (error) {
        const errorMessage = formatSpotifyError(error);
        log(`Error processing playlist "${playlist.name}":\n${errorMessage}`);
      }
    }

    if (playlistEmbeds.length === 0) {
      throw new Error("No valid playlists could be created");
    }

    const htmlResponse = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>AI Generated Playlists - Preview</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f4f4f4;
          }
          h1 {
            color: #1DB954;
            text-align: center;
            margin-bottom: 30px;
          }
          .playlist-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
          }
          .playlist-card {
            background-color: #fff;
            border-radius: 8px;
            padding: 20px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
          }
          h2 {
            color: #1DB954;
            margin-top: 0;
          }
          p {
            margin-bottom: 15px;
          }
          iframe {
            border-radius: 12px;
          }
        </style>
      </head>
      <body>
        <h1>AI Generated Playlists</h1>
        <div class="playlist-grid">
          ${playlistEmbeds.join("")}
        </div>
      </body>
      </html>
    `;

    log("Sending HTML response with embedded players");
    res.send(htmlResponse);

    // // Optional: Delete the created playlists after a certain time
    // setTimeout(async () => {
    //   try {
    //     for (const playlistId of createdPlaylistIds) {
    //       await requestQueue.add(() => spotifyApi.unfollowPlaylist(playlistId));
    //       log(`Deleted playlist: ${playlistId}`);
    //     }
    //   } catch (error) {
    //     log(`Error deleting playlists: ${formatSpotifyError(error)}`);
    //   }
    // }, 3600000); // Delete after 1 hour
  } catch (error) {
    const errorMessage = formatSpotifyError(error);
    log(`Error creating preview playlists:\n${errorMessage}`);
    res.status(500).send(`Error: ${errorMessage}`);
  }
});

app.post("/create-custom-playlist", async (req: Request, res: Response) => {
  try {
    await refreshTokenIfNeeded();

    const userPrompt = req.body.prompt;
    if (!userPrompt) {
      return res.status(400).send("Prompt is required");
    }

    log(`Received custom playlist prompt: ${userPrompt}`);

    const customPlaylist = await generateCustomPlaylistWithClaude(userPrompt);
    const trackUris = await findTrackUris(customPlaylist.songs);

    const validTrackUris = trackUris.filter(
      (uri): uri is string => uri !== undefined
    );

    if (validTrackUris.length === 0) {
      return res
        .status(404)
        .send("No valid tracks found for the custom playlist");
    }

    const newPlaylist = await requestQueue.add(() =>
      spotifyApi.createPlaylist(customPlaylist.name, {
        description: customPlaylist.description,
        public: false,
      })
    );

    await requestQueue.add(() =>
      spotifyApi.addTracksToPlaylist(newPlaylist.body.id, validTrackUris)
    );

    const playlistEmbed = `
      <div class="playlist-card">
        <h2>${customPlaylist.name}</h2>
        <p>${customPlaylist.description}</p>
        <iframe 
          src="https://open.spotify.com/embed/playlist/${newPlaylist.body.id}?utm_source=generator" 
          width="100%" 
          height="352" 
          frameBorder="0" 
          allowfullscreen="" 
          allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" 
          loading="lazy">
        </iframe>
      </div>
    `;

    const htmlResponse = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${customPlaylist.name} - Custom Playlist</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f4f4f4;
          }
          h1, h2 {
            color: #1DB954;
          }
          .playlist-card {
            background-color: #fff;
            border-radius: 8px;
            padding: 20px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
          }
          iframe {
            border-radius: 12px;
          }
          .nav {
            background-color: #1DB954;
            color: white;
            padding: 10px;
            margin-bottom: 20px;
          }
          .nav a {
            color: white;
            text-decoration: none;
            margin-right: 15px;
          }
        </style>
      </head>
      <body>
        <div class="nav">
          <a href="/">Home</a>
          <a href="/preview-playlists">Random Playlists</a>
        </div>
        <h1>Your Custom Playlist</h1>
        ${playlistEmbed}
      </body>
      </html>
    `;

    res.send(htmlResponse);
  } catch (error) {
    const errorMessage = formatSpotifyError(error);
    log(`Error creating custom playlist:\n${errorMessage}`);
    res.status(500).send(`Error: ${errorMessage}`);
  }
});

async function refreshTokenIfNeeded(): Promise<void> {
  try {
    const tokenData: TokenData = JSON.parse(
      await fs.readFile(tokenPath, "utf8")
    );

    if (Date.now() > tokenData.expires_at - 300000) {
      log("Access token expired or expiring soon, refreshing");
      spotifyApi.setRefreshToken(tokenData.refresh_token);
      const data = await spotifyApi.refreshAccessToken();
      const { access_token, expires_in } = data.body;

      await fs.writeFile(
        tokenPath,
        JSON.stringify({
          access_token,
          refresh_token: tokenData.refresh_token,
          expires_at: Date.now() + expires_in * 1000,
        })
      );

      spotifyApi.setAccessToken(access_token);
      log("Access token refreshed and saved");
    } else {
      log("Access token still valid");
      spotifyApi.setAccessToken(tokenData.access_token);
    }
  } catch (error) {
    log(`Failed to refresh token: ${error}`);
    throw new Error("Failed to refresh token. Please log in again.");
  }
}

async function getAllLikedSongs(): Promise<LikedSong[]> {
  let allTracks: LikedSong[] = [];
  let offset = 0;
  const limit = 50; // Spotify API allows a maximum of 50 tracks per request
  let total: number;

  do {
    log(`Fetching liked songs: offset ${offset}`);
    const data = await spotifyApi.getMySavedTracks({ limit, offset });
    total = data.body.total;

    const tracks: LikedSong[] = data.body.items.map((item) => ({
      name: item.track.name,
      artist: item.track.artists[0].name,
      id: item.track.id,
    }));

    allTracks = allTracks.concat(tracks);
    offset += limit;
    log(`Fetched ${allTracks.length}/${total} liked songs`);
  } while (offset < total);

  return allTracks;
}

async function generateOrLoadPlaylists(
  likedSongs: LikedSong[]
): Promise<Playlist[]> {
  if (isDevelopment) {
    try {
      log("Attempting to load saved playlists");
      const savedPlaylists = await fs.readFile(savedPlaylistsPath, "utf8");
      log("Using saved playlists");
      return JSON.parse(savedPlaylists);
    } catch (error) {
      log("No saved playlists found, generating new ones");
      return generatePlaylistsWithClaude(likedSongs);
    }
  } else {
    log("Production mode: Generating new playlists");
    return generatePlaylistsWithClaude(likedSongs);
  }
}

async function generateCustomPlaylistWithClaude(
  userPrompt: string
): Promise<Playlist> {
  log("Generating custom playlist with Claude");
  const prompt = `
You are an innovative AI DJ tasked with creating a unique and engaging playlist based on the following user prompt:

"${userPrompt}"

Instructions:
1. Create a playlist with 20-25 songs that fits the theme or mood described in the prompt.
2. Give the playlist a creative, catchy name that reflects its theme.
3. Provide a brief, engaging description for the playlist (max 50 words).
4. Include a mix of well-known and lesser-known tracks that fit the theme.
5. Make unexpected connections between songs where appropriate.
6. Avoid overly obvious song choices; aim for originality and creativity in selections.

Diversity and theme balance:
7. Include 2-3 songs from artists specifically mentioned in the user prompt.
8. Allow up to 3 songs per artist, but aim for variety when possible.
9. Include at least 3 lesser-known or up-and-coming artists in the genre.
10. Include artists from at least 3 different countries.
11. Include 1-2 crossover tracks from related genres that fit the overall mood and theme.

Song selection process:
12. Prioritize maintaining the theme and mood of the playlist over strict diversity rules.
13. For each song, consider how it fits the theme and contributes to the playlist's overall feel.
14. If including multiple songs from one artist, ensure they showcase different aspects of their style.
15. Consider instrumental tracks or remixes that fit the theme to add variety.

Respond with a JSON object representing the playlist. The object should have the following structure:
{
  "name": "Playlist Name",
  "description": "Brief, engaging description of the playlist (max 50 words)",
  "songs": [
    {
      "title": "Song Title",
      "artist": "Artist Name",
      "country": "Artist's Country of Origin"
    },
    ...
  ]
}

Your response should contain only the JSON object, with no additional text or explanation.
  `;

  log("Sending request to Claude API");
  const response = await anthropic.messages.create({
    model: "claude-3-sonnet-20240229",
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  });

  log("Received response from Claude API");
  return JSON.parse((response.content[0] as Anthropic.TextBlock).text);
}

async function generatePlaylistsWithClaude(
  likedSongs: LikedSong[]
): Promise<Playlist[]> {
  log("Generating playlists with Claude");
  const prompt = `
    You are an innovative AI DJ tasked with creating unique and engaging playlists from a user's collection of liked songs. Your goal is to surprise and delight the user with unexpected combinations and creative themes.

    Instructions:
    1. Create 5-7 distinctive playlists.
    2. Each playlist should have 15-30 songs, but the exact number can vary based on the theme.
    3. Give each playlist a creative, catchy name that reflects its theme.
    4. Provide a brief, engaging description for each playlist.
    5. Think beyond generic categories like genre or era. Consider themes based on:
       - Specific moods or emotions
       - Narrative arcs
       - Unconventional connections between songs
       - Imaginary scenarios
    6. Include a mix of well-known and lesser-known tracks in each playlist.
    7. Make unexpected connections between songs where appropriate.

    Respond with a JSON array of playlist objects. Each playlist object should have the following structure:
    {
      "name": "Playlist Name",
      "description": "Brief, engaging description of the playlist",
      "songs": [
        {
          "title": "Song Title",
          "artist": "Artist Name"
        },
        ...
      ]
    }

    Your response should contain only the JSON array, with no additional text or explanation.

    Here's the list of liked songs:
    ${JSON.stringify(likedSongs)}
  `;

  log("Sending request to Claude API");
  const response = await anthropic.messages.create({
    model: "claude-3-sonnet-20240229",
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  });

  log("Received response from Claude API");
  return JSON.parse((response.content[0] as Anthropic.TextBlock).text);
}

app.listen(port, () => {
  log(`Server running at http://localhost:${port}`);
});
