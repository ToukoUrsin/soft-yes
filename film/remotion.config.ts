import {Config} from '@remotion/cli/config';
Config.setVideoImageFormat('jpeg');
Config.setJpegQuality(94);
Config.setPublicDir(process.env.FILM_BULK ? `${process.env.FILM_BULK}/public` : '/bulk2/runs/cala/film/public');
